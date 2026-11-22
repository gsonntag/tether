import { accountIdentity } from "../../accountIdentity";
// One process, one billing source. Keys stay in the runner's file and private lease memory.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AccountSource, isAccountSource, isSubscriptionSource } from "../../../../shared/credentials";
import type { Billing } from "../../../../shared/transcript";
import type { CredentialSnapshot } from "../../credentials";
import { shq } from "../../terminal/hooks";
import { claudeBilling } from "./context";

export const CLAUDE_AUTH_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "CLAUDE_CODE_USE_MANTLE",
];

/** No raw key enters the harness environment: shell tools must never inherit it. */
export function claudeEnv(credential?: CredentialSnapshot, inherited: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(inherited)) if (!/^(TETHER_|OPENAI_|AZURE_|CODEX_API_KEY)/.test(k) && !CLAUDE_AUTH_ENV.includes(k)) env[k] = v;
  for (const k of CLAUDE_AUTH_ENV) env[k] = undefined;
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = "1";
  if (credential?.claudeAccount) env.CLAUDE_CONFIG_DIR = credential.claudeAccount.configDir;
  if (credential && !isSubscriptionSource(credential.source) && credential.source !== "anthropic") throw new Error("Claude cannot use that billing source.");
  for (const k of ["DEBUG", "CLAUDE_DEBUG", "CLAUDE_CODE_DEBUG"]) delete env[k];
  return env;
}

export function claudeAuthSettings(helper = "") {
  // An empty descriptor is fd 0 to Claude, not an absent credential.
  return { apiKeyHelper: helper, env: Object.fromEntries(CLAUDE_AUTH_ENV.filter((k) => !k.endsWith("_FILE_DESCRIPTOR")).map((k) => [k, ""])) };
}

export const claudeAccountLabel = (source: AccountSource) => `Claude plan · ${source.slice(8, 16)}`;

type ClaudeIdentity = { email: string; organization: string };

/** Text from a PTY. The CLI writes spaces as cursor moves there, so replay those moves instead of dropping them. */
export function ptyText(output: string): string {
  let text = "";
  for (const part of output.split(/(\x1b\[[0-?]*[ -/]*[@-~]|\r?\n|\r)/)) {
    if (part === "\r") continue;
    if (part === "\n" || part === "\r\n") { text += "\n"; continue; }
    const move = /^\x1b\[(\d*)([CG])$/.exec(part);
    if (move) {
      const col = text.length - text.lastIndexOf("\n") - 1;
      const n = Number(move[1] || 1);
      text += " ".repeat(Math.max(0, move[2] === "C" ? n : n - 1 - col));
    } else if (!part.startsWith("\x1b[")) text += part;
  }
  return text;
}

/** Compared without whitespace: auth status and the SDK space the same name differently. */
function normalizedOrganization(name: string, email: string) {
  const normalized = name.replace(/[‘’]/g, "'").replace(/\s+/g, "");
  return normalized.toLowerCase() === `${email.toLowerCase()}'sorganization` ? normalized.toLowerCase() : normalized;
}

function sameClaudeIdentity(actual: unknown, expected: ClaudeIdentity) {
  const account = actual as { email?: unknown; organization?: unknown; orgName?: unknown } | undefined;
  const name = account?.organization ?? account?.orgName;
  return typeof account?.email === "string" && typeof name === "string" &&
    account.email.toLowerCase() === expected.email.toLowerCase() &&
    normalizedOrganization(name, account.email) === normalizedOrganization(expected.organization, expected.email);
}

/** Refuse before the first user token unless the harness confirms the configured source. */
export function confirmClaudeBilling(account: unknown, credential?: CredentialSnapshot, expected: ClaudeIdentity | undefined = credential?.claudeAccount): Billing {
  const billing = claudeBilling(account);
  const report = account as { apiProvider?: string; apiKeySource?: string; tokenSource?: string } | undefined;
  const source = credential?.source ?? "subscription";
  const confirmed = source === "anthropic"
    ? billing.kind === "apiKey" && billing.label === "Anthropic API key" && report?.apiProvider === "firstParty" && report.apiKeySource === "apiKeyHelper"
    : isSubscriptionSource(source) && billing.kind === "plan" && report?.apiProvider === "firstParty" && (!report.apiKeySource || report.apiKeySource === "none" || report.apiKeySource === "oauth") && (!report.tokenSource || report.tokenSource === "claude.ai");
  if (!confirmed) throw new Error(`Claude could not confirm ${source === "anthropic" ? "the Anthropic API key" : "the Claude subscription"}. Sending is blocked. Check Credentials.`);
  if ((expected && !sameClaudeIdentity(account, expected)) || (isAccountSource(source) && !expected)) {
    throw new Error("Claude could not confirm the Claude subscription account. Check Accounts. Nothing was sent.");
  }
  if (isAccountSource(source)) return { kind: "plan", label: claudeAccountLabel(source), source };
  return billing;
}

/** A frozen key lease: helper responses are private, and changing the file cannot rotate a live turn. */
export function claudeKeyLease(credential?: CredentialSnapshot): { helper: string; close(): void } {
  if (credential?.source !== "anthropic") return { helper: "", close() {} };
  if (!credential.key || !credential.file) throw new Error("The Anthropic API key is unavailable. Check Credentials.");
  const scripts = claudeTerminalScripts(credential.file);
  const socket = join(dirname(credential.file), `k-${randomBytes(6).toString("hex")}.sock`);
  if (Buffer.byteLength(socket) > 103) throw new Error("The runner data path is too long for a private key socket.");
  const key = credential.key;
  const server = Bun.serve({ unix: socket, fetch: (request) => new URL(request.url).pathname === "/key" ? new Response(key, { headers: { "cache-control": "no-store" } }) : new Response("", { status: 404 }) });
  chmodSync(socket, 0o600);
  return {
    helper: `${shq(process.execPath)} ${shq(scripts.helper)} ${shq(socket)}`,
    close() { server.stop(true); try { unlinkSync(socket); } catch {} },
  };
}

/** auth status is read-only: no turn and no trust prompt. Async so its helper can reach the lease. */
export async function confirmClaudeTerminal(binary: string, credential: CredentialSnapshot | undefined, settings: Record<string, unknown>, cwd?: string): Promise<Billing> {
  const status = await claudeAuthStatus(binary, credential, settings, cwd);
  if (credential?.claudeAccount) confirmClaudeStatusIdentity(status, credential.claudeAccount);
  return confirmClaudeBilling(status, credential);
}

async function claudeAuthStatus(binary: string, credential: CredentialSnapshot | undefined, settings: Record<string, unknown>, cwd?: string, configDir?: string): Promise<any> {
  let output = "";
  const decoder = new TextDecoder();
  // The native CLI loses auth-status stdout when it is launched with Bun pipe handles.
  // A PTY preserves its output; this is only the read-only auth subcommand, never the TUI.
  const result = Bun.spawn([binary, "--settings", JSON.stringify(settings), "auth", "status", "--json"], {
    env: { ...claudeEnv(credential), ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}) }, ...(cwd ? { cwd } : {}),
    terminal: { cols: 200, rows: 80, data: (_terminal, bytes) => { if (output.length < 65536) output += decoder.decode(bytes, { stream: true }); } },
  });
  const timer = setTimeout(() => result.kill("SIGKILL"), 15_000);
  let account: any;
  try {
    const status = await result.exited;
    await Bun.sleep(25);
    const clean = ptyText(output);
    if (status === 0 || status === 1) try { account = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1)); } catch {}
  } finally { clearTimeout(timer); result.terminal?.close(); }
  if (account?.authMethod === "claude.ai" && account.loggedIn === true) account.subscriptionType ||= "Claude plan";
  return account;
}

/** The CLI's OAuth account, independent of a configured Tether key. */
export async function claudeSubscriptionStatus(binary: string, configDir?: string) {
  return claudeAuthStatus(binary, undefined, claudeAuthSettings(), undefined, configDir);
}

function confirmClaudeStatusIdentity(status: any, expected: ClaudeIdentity & { accountId: string }) {
  if (status?.authMethod !== "claude.ai" || status.loggedIn !== true ||
      accountIdentity(status.email, status.subscriptionType, status.orgName, status.orgId).accountId !== expected.accountId) {
    throw new Error("Claude could not confirm the Claude subscription account. Check Accounts. Nothing was sent.");
  }
}

/** Read the account's organization ID from the CLI before checking the live SDK identity. */
export async function expectedClaudeIdentity(binary: string, credential?: CredentialSnapshot): Promise<ClaudeIdentity | undefined> {
  const source = credential?.source;
  if (!source || !isSubscriptionSource(source)) return;
  const expected = credential.claudeAccount;
  const status = await claudeSubscriptionStatus(binary, expected?.configDir);
  if (expected) confirmClaudeStatusIdentity(status, expected);
  confirmClaudeBilling(status, credential);
  if (typeof status.email !== "string" || !status.email || typeof status.orgName !== "string" || !status.orgName) {
    throw new Error("Claude could not confirm the Claude subscription account. Check Accounts. Nothing was sent.");
  }
  return expected ?? { email: status.email, organization: status.orgName };
}

export function clearClaudeLoginStatus() {
  login = undefined;
}

const LOGIN_MS = 30_000;
let login: { at: number; yes: Promise<boolean> } | undefined;
/** Whether Claude Code has a subscription login, with no key in reach. Starts a read-only status command. */
export function claudeLoggedIn(binary: string): Promise<boolean> {
  if (login && Date.now() - login.at < LOGIN_MS) return login.yes;
  const yes = claudeAuthStatus(binary, undefined, claudeAuthSettings()).then((a) => { try { return confirmClaudeBilling(a).kind === "plan"; } catch { return false; } }, () => false);
  login = { at: Date.now(), yes };
  return yes;
}

export async function prepareClaudeTerminal(binary: string, credential?: CredentialSnapshot, cwd?: string): Promise<Billing> {
  const lease = claudeKeyLease(credential);
  try { return await confirmClaudeTerminal(binary, credential, claudeAuthSettings(lease.helper), cwd); }
  finally { lease.close(); }
}

function privateScript(file: string, source: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, source, { mode: 0o700 });
  chmodSync(tmp, 0o700);
  renameSync(tmp, file);
}

/** The launcher snapshots a key in memory, serves its own lease and redacts the terminal PTY. */
export function claudeTerminalScripts(file: string): { launcher: string; helper: string } {
  const dir = join(dirname(file), "claude-launch");
  const helper = join(dir, "api-key.mjs");
  privateScript(helper, `try { const r = await fetch("http://tether/key", { unix: process.argv[2], signal: AbortSignal.timeout(10000) }); if (!r.ok) process.exit(1); process.stdout.write(await r.text()); } catch { process.exit(1); }\n`);
  const launcher = join(dir, "launch.mjs");
  privateScript(launcher, `import { readFileSync, chmodSync, unlinkSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
const ptyText = ${ptyText.toString()};
const normalizedOrganization = ${normalizedOrganization.toString()};
const [file, revision, source, ...argv] = process.argv.slice(2);
let server, socket;
try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TETHER_|OPENAI_|AZURE_|CODEX_API_KEY)/.test(k) && !${JSON.stringify(CLAUDE_AUTH_ENV)}.includes(k)));
  for (const k of ${JSON.stringify(CLAUDE_AUTH_ENV)}) delete env[k];
  for (const k of ["DEBUG", "CLAUDE_DEBUG", "CLAUDE_CODE_DEBUG"]) delete env[k];
  if (!env.CLAUDE_CONFIG_DIR) delete env.CLAUDE_CONFIG_DIR;
  let key;
  if (source === "anthropic") {
    const selected = JSON.parse(readFileSync(file, "utf8")).anthropic;
    if (!selected?.key || selected.revision !== revision) throw new Error();
    key = selected.key;
    socket = join(dirname(file), "k-" + randomBytes(6).toString("hex") + ".sock");
    if (Buffer.byteLength(socket) > 103) throw new Error();
    server = Bun.serve({ unix: socket, fetch: (r) => new URL(r.url).pathname === "/key" ? new Response(key, { headers: { "cache-control": "no-store" } }) : new Response("", { status: 404 }) });
    chmodSync(socket, 0o600);
  } else if (source.startsWith("account:")) {
    env.CLAUDE_CONFIG_DIR = argv.shift();
    const expected = JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR, ".tether-account.json"), "utf8"));
    let report = "";
    const statusDecoder = new TextDecoder();
    const status = Bun.spawn([argv[0], "--settings", argv[argv.indexOf("--settings") + 1], "auth", "status", "--json"], {
      env, terminal: { cols: 200, rows: 80, data: (_, data) => { if (report.length < 65536) report += statusDecoder.decode(data, { stream: true }); } },
    });
    const timer = setTimeout(() => status.kill("SIGKILL"), 10000);
    const code = await status.exited;
    clearTimeout(timer);
    await Bun.sleep(25);
    status.terminal.close();
    const clean = ptyText(report);
    const account = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
    const scope = typeof account.orgId === "string" && account.orgId.length <= 128 ? account.orgId : account.orgName?.trim();
    const identity = createHash("sha256").update(JSON.stringify([account.email?.toLowerCase(), scope])).digest("hex");
    if (identity !== expected.accountId || code !== 0 || account.authMethod !== "claude.ai" || account.loggedIn !== true ||
        account.email?.toLowerCase() !== expected.email.toLowerCase() || typeof account.orgName !== "string" ||
        normalizedOrganization(account.orgName, account.email) !== normalizedOrganization(expected.organization, expected.email) ||
        account.apiProvider !== "firstParty" || (account.apiKeySource && !["none", "oauth"].includes(account.apiKeySource)) ||
        (account.tokenSource && account.tokenSource !== "claude.ai")) throw new Error();
  } else if (source !== "subscription") throw new Error();
  const at = argv.indexOf("--settings");
  if (at < 0) throw new Error();
  const settings = JSON.parse(argv[at + 1]);
  const quote = (s) => "'" + s.split("'").join("'" + String.fromCharCode(92) + "''") + "'";
  settings.apiKeyHelper = key ? quote(process.execPath) + " " + quote(${JSON.stringify(helper)}) + " " + quote(socket) : "";
  argv[at + 1] = JSON.stringify(settings);
  let pending = "";
  const decoder = new TextDecoder();
  const output = (bytes) => {
    let text = pending + decoder.decode(bytes, { stream: true });
    pending = "";
    if (key) {
      text = text.split(key).join("[redacted]");
      for (let n = Math.min(key.length - 1, text.length); n > 0; n--) {
        if (text.endsWith(key.slice(0, n))) { pending = text.slice(-n); text = text.slice(0, -n); break; }
      }
    }
    process.stdout.write(text);
  };
  const p = Bun.spawn(argv, { env, terminal: { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24, data: (_terminal, data) => output(data) } });
  const input = (data) => p.terminal.write(data);
  process.stdin.setRawMode?.(true);
  process.stdin.on("data", input);
  process.stdout.on("resize", () => p.terminal.resize(process.stdout.columns || 80, process.stdout.rows || 24));
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, () => p.kill(signal));
  const status = await p.exited;
  process.stdin.off("data", input);
  process.stdin.setRawMode?.(false);
  p.terminal.close();
  // Never flush a held key prefix at exit.
  server?.stop(true); if (socket) try { unlinkSync(socket); } catch {}
  process.exit(status);
} catch {
  server?.stop(true); if (socket) try { unlinkSync(socket); } catch {}
  console.error("Claude terminal billing could not be confirmed. Reopen the terminal after checking Credentials.");
  process.exit(1);
}
`);
  return { launcher, helper };
}
