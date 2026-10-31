// One process, one billing source. Keys stay in the runner's file and private lease memory.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  if (credential && credential.source !== "subscription" && credential.source !== "anthropic") throw new Error("Claude cannot use that billing source.");
  for (const k of ["DEBUG", "CLAUDE_DEBUG", "CLAUDE_CODE_DEBUG"]) delete env[k];
  return env;
}

export function claudeAuthSettings(helper = "") {
  // An empty descriptor is fd 0 to Claude, not an absent credential.
  return { apiKeyHelper: helper, env: Object.fromEntries(CLAUDE_AUTH_ENV.filter((k) => !k.endsWith("_FILE_DESCRIPTOR")).map((k) => [k, ""])) };
}

/** Refuse before the first user token unless the harness confirms the configured source. */
export function confirmClaudeBilling(account: unknown, credential?: CredentialSnapshot): Billing {
  const billing = claudeBilling(account);
  const report = account as { apiProvider?: string; apiKeySource?: string; tokenSource?: string } | undefined;
  const source = credential?.source ?? "subscription";
  const confirmed = source === "anthropic"
    ? billing.kind === "apiKey" && billing.label === "Anthropic API key" && report?.apiProvider === "firstParty" && report.apiKeySource === "apiKeyHelper"
    : source === "subscription" && billing.kind === "plan" && report?.apiProvider === "firstParty" && (!report.apiKeySource || report.apiKeySource === "none" || report.apiKeySource === "oauth") && (!report.tokenSource || report.tokenSource === "claude.ai");
  if (!confirmed) throw new Error(`Claude could not confirm ${source === "anthropic" ? "the Anthropic API key" : "the Claude subscription"}. Sending is blocked. Check Credentials.`);
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
  let output = "";
  const decoder = new TextDecoder();
  // The native CLI loses auth-status stdout when it is launched with Bun pipe handles.
  // A PTY preserves its output; this is only the read-only auth subcommand, never the TUI.
  const result = Bun.spawn([binary, "--settings", JSON.stringify(settings), "auth", "status", "--json"], {
    env: claudeEnv(credential), ...(cwd ? { cwd } : {}),
    terminal: { cols: 200, rows: 80, data: (_terminal, bytes) => { if (output.length < 65536) output += decoder.decode(bytes, { stream: true }); } },
  });
  const timer = setTimeout(() => result.kill("SIGKILL"), 15_000);
  let account: any;
  try {
    const status = await result.exited;
    await Bun.sleep(25);
    const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
    if (status === 0) try { account = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1)); } catch {}
  } finally { clearTimeout(timer); result.terminal?.close(); }
  if (account?.authMethod === "claude.ai" && account.loggedIn === true) account.subscriptionType ||= "Claude plan";
  return confirmClaudeBilling(account, credential);
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
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
const [file, revision, source, ...argv] = process.argv.slice(2);
let server, socket;
try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TETHER_|OPENAI_|AZURE_|CODEX_API_KEY)/.test(k) && !${JSON.stringify(CLAUDE_AUTH_ENV)}.includes(k)));
  for (const k of ${JSON.stringify(CLAUDE_AUTH_ENV)}) delete env[k];
  for (const k of ["DEBUG", "CLAUDE_DEBUG", "CLAUDE_CODE_DEBUG"]) delete env[k];
  let key;
  if (source === "anthropic") {
    const selected = JSON.parse(readFileSync(file, "utf8")).anthropic;
    if (!selected?.key || selected.revision !== revision) throw new Error();
    key = selected.key;
    socket = join(dirname(file), "k-" + randomBytes(6).toString("hex") + ".sock");
    if (Buffer.byteLength(socket) > 103) throw new Error();
    server = Bun.serve({ unix: socket, fetch: (r) => new URL(r.url).pathname === "/key" ? new Response(key, { headers: { "cache-control": "no-store" } }) : new Response("", { status: 404 }) });
    chmodSync(socket, 0o600);
  } else if (source === "subscription") {
    let selected;
    try { selected = JSON.parse(readFileSync(file, "utf8")).anthropic; } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (selected) throw new Error();
  } else throw new Error();
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
