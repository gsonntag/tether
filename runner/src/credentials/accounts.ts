// Harness logins and extra accounts (.claude/credentials/SPEC.md sections 3 and 4): one credential
// plugin per subscription provider.
//   claude       Claude Code: "claude:machine" (its own login) + "claude:<name>" (CLAUDE_CONFIG_DIR)
//   chatgpt      Codex and pi's openai-codex: "chatgpt:codex", "chatgpt:pi" (the machine's two
//                logins) + "chatgpt:<name>" (CODEX_HOME for Codex, PI_CODING_AGENT_DIR for pi)
//   kiro         kiro-cli's login, "kiro:machine" (one per machine)
//   antigravity  agy's login, "antigravity:machine" (when installed)
//
// The machine's own logins are listed in place: never moved, never written, except when you sign
// in to (or out of) one of them explicitly, through the CLI's own login/logout. An extra account
// gets its own home under <config>/accounts/<id>/<harness>, which mirrors the machine's config
// (settings, sessions, plugins: symlinks) except the login file, so its sessions keep their
// history next to the others and only the login differs. Sign out of an extra account = its home
// is removed (the links in it, never what they point to).
//
// Credentials never leave the runner: views carry the account's email, plan, state and usage.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ACCOUNT_NAME, RESERVED_ACCOUNT_NAMES, accountSlug, type SignInResult } from "../../../web/src/shared/accounts";
import type { CredentialModel, CredentialState, CredentialView } from "../../../web/src/shared/credentials";
import type { ChainEntry, HarnessId, ModelRef, ProviderUsage, UsageWindow } from "../../../web/src/shared/protocol";
import { userHome } from "../home";
import { accountUsage, getUsage, usageAt } from "../usage";
import { usedIn, type CredentialPlugin } from "./registry";
import { cancelFlow, flowFor, startCommand, startRelay, submitCode } from "./signin";
import { accountsDir } from "./store";

/** The foundation's plugin plus `homeFor` (the account's own home for a harness, for readers of native session files). */
export interface AccountPlugin extends CredentialPlugin {
  homeFor(credId: string, harness: HarnessId): string | undefined;
}

// ---------------- binaries and machine homes ----------------

const CLAUDE_BIN = () => process.env.CLAUDE_BIN ?? Bun.which("claude") ?? "claude";
const CODEX_BIN = () => process.env.CODEX_BIN ?? "codex";
const PI_BIN = () => process.env.PI_BIN ?? "pi";
const KIRO_BIN = () => process.env.KIRO_BIN ?? "kiro-cli";
const AGY_BIN = () => process.env.AGY_BIN ?? "agy";
const installed = (bin: string) => !!Bun.which(bin);

export const machineClaudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(userHome(), ".claude");
export const machineCodexHome = () => process.env.CODEX_HOME ?? join(userHome(), ".codex");
export const machinePiDir = () => process.env.PI_CODING_AGENT_DIR ?? join(userHome(), ".pi", "agent");
const agyToken = () => join(userHome(), ".gemini", "antigravity-cli", "antigravity-oauth-token");

type Part = "claude" | "codex" | "pi";
/** The login file in each kind of home: the one thing an account's home doesn't share. */
export const LOGIN_FILES: Record<Part, string[]> = {
  claude: [".credentials.json", ".claude.json"],
  codex: ["auth.json"],
  pi: ["auth.json"],
};

/**
 * Entries an account home never shares: its login files, and the machine CLI's live process state
 * (daemons, locks, sockets, per-process state, SQLite databases and their -wal/-shm). The account's
 * CLI makes its own.
 */
const UNSHARED: Record<Part, RegExp> = {
  claude: /^(\.credentials\.json|\.claude\.json|daemon|daemon\.lock|daemon\.status\.json|session-env|sessions|backups|.*\.lock)$/,
  codex: /^(auth\.json|app-server-daemon|app-server-control|thread-writer-locks|backups|.*\.sqlite(-wal|-shm)?|.*\.lock)$/,
  pi: /^(auth\.json|.*\.lock)$/,
};

/** Variables that would put an account's process on another login or endpoint: blanked when the runner has them. */
const FOREIGN_ENV: Record<Part, string[]> = {
  claude: [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"],
  pi: [],
};
const blanked = (part: Part): Record<string, string> => Object.fromEntries(FOREIGN_ENV[part].filter((k) => process.env[k]).map((k) => [k, ""]));
const machineDir = (p: Part) => (p === "claude" ? machineClaudeDir() : p === "codex" ? machineCodexHome() : machinePiDir());

// ---------------- account homes ----------------

const isMachine = (id: string) => /^(claude:machine|chatgpt:codex|chatgpt:pi|kiro:machine|antigravity:machine)$/.test(id);

/** An extra account's id, checked: "<provider>:<name>" with a name an account may have. */
function extraId(id: string, provider?: string): string {
  const [p, name, ...rest] = id.split(":");
  if (rest.length || !name || (provider && p !== provider) || !["claude", "chatgpt"].includes(p!) || !ACCOUNT_NAME.test(name) || RESERVED_ACCOUNT_NAMES.includes(name))
    throw new Error(`“${id}” isn't an extra account.`);
  return id;
}

/** <config>/accounts/<id>: everything the account has on this runner. */
export function accountHome(id: string): string {
  const root = resolve(accountsDir());
  const home = resolve(root, extraId(id));
  if (!home.startsWith(root + sep)) throw new Error(`“${id}” isn't an extra account.`);
  return home;
}

/** One harness's home inside an account: CLAUDE_CONFIG_DIR, CODEX_HOME or pi's agent dir. */
export const partHome = (id: string, part: Part) => join(accountHome(id), part);

/**
 * Links every entry of the machine's config dir into the account's (settings, projects, sessions,
 * plugins…) except its login files, which the account signs in to on its own. Entries the account
 * already has stay; anything new on the machine shows up the next time it's mirrored (every start).
 */
export function mirror(src: string, dst: string, skip: RegExp) {
  mkdirSync(dst, { recursive: true, mode: 0o700 });
  let names: string[] = [];
  try {
    names = readdirSync(src);
  } catch {}
  for (const n of names) {
    if (skip.test(n)) continue;
    const to = join(dst, n);
    try {
      lstatSync(to);
      continue;
    } catch {}
    try {
      symlinkSync(join(src, n), to);
    } catch {}
  }
}

/**
 * The account's home for one harness, mirrored now. Only a sign-in creates an account (`create`):
 * a session or usage check on one that was signed out fails instead of bringing its home back.
 */
export function preparedHome(id: string, part: Part, create = false): string {
  if (!create && !existsSync(accountHome(id))) throw new Error(`${id} was signed out: it isn't on this runner any more.`);
  const dir = partHome(id, part);
  mirror(machineDir(part), dir, UNSHARED[part]);
  // Claude Code keeps its account state in .claude.json; a new one starts past the first-run screens.
  if (part === "claude" && !existsSync(join(dir, ".claude.json")))
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }) + "\n", { mode: 0o600 });
  return dir;
}

/** The extra accounts of a provider on this runner: the homes under <config>/accounts. */
export function extraAccounts(provider: "claude" | "chatgpt"): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(accountsDir());
  } catch {}
  return names
    .filter((n) => {
      try {
        extraId(n, provider);
        return statSync(join(accountsDir(), n)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** Signs an extra account out: its home goes (rmSync unlinks the mirrored links, never their targets). */
export function removeAccountHome(id: string) {
  cancelFlow(id);
  rmSync(accountHome(id), { recursive: true, force: true });
  forget(id);
}

// ---------------- reading logins (no value ever leaves) ----------------

/** A JWT's claims, read locally (no check needed: the CLI's own file). */
function jwtClaims(t: unknown): Record<string, any> | undefined {
  if (typeof t !== "string") return undefined;
  try {
    return JSON.parse(Buffer.from(t.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

const readJson = (path: string): any => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

export interface LoginInfo {
  signedIn: boolean;
  email?: string;
  org?: string;
  plan?: string;
  /** what the CLI says when it couldn't tell */
  note?: string;
  /** it has a refresh token: a refused access token only means the CLI hasn't refreshed it yet */
  refreshable?: boolean;
}

/** Without the machine's token variables: an account's process runs on its own login. */
function ownEnv(extra: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  for (const k of [...FOREIGN_ENV.claude, ...FOREIGN_ENV.codex]) delete env[k];
  return env;
}

async function run(argv: string[], env: Record<string, string | undefined>, ms = 15_000): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(argv, {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd: userHome(),
  });
  const t = setTimeout(() => p.kill(), ms);
  try {
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out: out + err };
  } finally {
    clearTimeout(t);
  }
}

const statusCache = new Map<string, { at: number; stamp: string; info: LoginInfo }>();
const STATUS_MS = 5 * 60_000;
const stampOf = (paths: string[]) =>
  paths
    .map((p) => {
      try {
        return String(statSync(p).mtimeMs);
      } catch {
        return "-";
      }
    })
    .join("|");

async function cachedStatus(key: string, watch: string[], read: () => Promise<LoginInfo>): Promise<LoginInfo> {
  const stamp = stampOf(watch);
  const c = statusCache.get(key);
  if (c && c.stamp === stamp && Date.now() - c.at < STATUS_MS) return c.info;
  const info = await read();
  statusCache.set(key, { at: Date.now(), stamp, info });
  return info;
}

/** Claude Code's own report (`claude auth status --json`): email, org, plan. `dir`: an account's CLAUDE_CONFIG_DIR. */
export async function claudeLogin(dir?: string): Promise<LoginInfo> {
  const cfg = dir ?? machineClaudeDir();
  const watch = [join(cfg, ".credentials.json"), dir ? join(cfg, ".claude.json") : join(userHome(), ".claude.json")];
  return cachedStatus(`claude:${cfg}`, watch, async () => {
    try {
      const { out } = await run([CLAUDE_BIN(), "auth", "status", "--json"], dir ? ownEnv({ CLAUDE_CONFIG_DIR: dir }) : process.env);
      const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
      return {
        signedIn: !!j.loggedIn,
        email: j.email ?? undefined,
        org: j.orgName ?? undefined,
        plan: j.subscriptionType ?? undefined,
      };
    } catch {
      // No CLI answer: the login file says enough to list it.
      return {
        signedIn: existsSync(watch[0]!) || (!dir && process.platform === "darwin"),
        note: "Claude Code didn't say who is signed in.",
      };
    }
  });
}

/** The Codex CLI's login in a CODEX_HOME: its ChatGPT account from the id token, or an API key. */
export function codexLogin(home: string): LoginInfo {
  const a = readJson(join(home, "auth.json"));
  if (!a) return { signedIn: false };
  const c = jwtClaims(a.tokens?.id_token);
  if (c || a.tokens?.access_token)
    return {
      signedIn: true,
      email: c?.email,
      plan: c?.["https://api.openai.com/auth"]?.chatgpt_plan_type,
      refreshable: !!a.tokens?.refresh_token,
    };
  if (a.OPENAI_API_KEY) return { signedIn: true, plan: "API key" };
  return { signedIn: false };
}

/** pi's ChatGPT login (openai-codex) in its agent dir. */
export function piLogin(dir: string): LoginInfo {
  const p = readJson(join(dir, "auth.json"))?.["openai-codex"];
  if (!p?.access && !p?.refresh) return { signedIn: false };
  const c = jwtClaims(p.access);
  return {
    signedIn: true,
    email: c?.["https://api.openai.com/profile"]?.email ?? c?.email,
    plan: c?.["https://api.openai.com/auth"]?.chatgpt_plan_type,
    refreshable: !!p.refresh,
  };
}

/** kiro-cli's login (`kiro-cli whoami`). */
async function kiroLogin(): Promise<LoginInfo> {
  const db = process.env.KIRO_DB ?? join(userHome(), ".local", "share", "kiro-cli", "data.sqlite3");
  return cachedStatus("kiro", [db], async () => {
    try {
      const { code, out } = await run([KIRO_BIN(), "whoami"], process.env);
      const email = out.match(/Email:\s*(\S+)/i)?.[1];
      return code === 0 ? { signedIn: true, email } : { signedIn: false };
    } catch {
      return { signedIn: false, note: "kiro-cli didn't answer." };
    }
  });
}

// ---------------- labels ----------------

const planName = (p?: string) => (p ? p.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : undefined);

/** "Max (gavin@)": the plan and whose it is, short enough for "Opus 5.5 · Max (gavin@)". */
export function accountLabel(info: LoginInfo, fallback: string): string {
  const who = info.email ? `${info.email.split("@")[0]}@` : undefined;
  const plan = planName(info.plan);
  if (plan && who) return `${plan} (${who})`;
  return who ?? plan ?? fallback;
}

// ---------------- usage (per account) ----------------

type UsageKey =
  | {
      kind: "machine";
      account: "claude" | "chatgpt:codex" | "chatgpt:pi" | "kiro";
    }
  | { kind: "home"; part: Part; dir: string };

const usageCache = new Map<string, { at: number; usage?: ProviderUsage }>();
const usageInflight = new Map<string, Promise<ProviderUsage | undefined>>();
const USAGE_MS = 2 * 60_000;

/** Fresh usage for one login (fallback's limit check). */
async function freshUsage(k: UsageKey): Promise<ProviderUsage | undefined> {
  if (k.kind === "machine") return accountUsage(k.account);
  return usageAt(k.part, k.dir, ownEnv({}));
}

/** Usage for a row: from the Usage page's report for Claude and Kiro, else fetched and kept a couple of minutes. */
async function rowUsage(id: string, k: UsageKey, waitMs = 6_000): Promise<ProviderUsage | undefined> {
  if (k.kind === "machine" && (k.account === "claude" || k.account === "kiro")) {
    const want = k.account;
    return Promise.race([getUsage().then((r) => r.providers.find((p) => p.provider === want)), Bun.sleep(waitMs).then(() => usageCache.get(id)?.usage)]).then((u) => {
      if (u) usageCache.set(id, { at: Date.now(), usage: u });
      return u;
    });
  }
  const c = usageCache.get(id);
  if (c && Date.now() - c.at < USAGE_MS) return c.usage;
  let p = usageInflight.get(id);
  if (!p) {
    p = freshUsage(k)
      .catch((e): ProviderUsage => ({
        provider: "codex",
        label: "",
        windows: [],
        error: e?.message ?? String(e),
      }))
      .then((usage) => {
        usageCache.set(id, { at: Date.now(), usage });
        return usage;
      })
      .finally(() => usageInflight.delete(id));
    usageInflight.set(id, p);
  }
  return Promise.race([p, Bun.sleep(waitMs).then(() => c?.usage)]);
}

function forget(id: string) {
  usageCache.delete(id);
  for (const k of [...statusCache.keys()]) if (k.includes(id)) statusCache.delete(k);
}

/** A usage error that means the login itself is refused (expired, revoked). */
const refused = (u?: ProviderUsage) => !!u?.error && /\b401\b|\b403\b|unauthori|expired|invalid.*token|revoked/i.test(u.error);

function stateOf(info: LoginInfo, usage?: ProviderUsage): { state: CredentialState; stateNote?: string } {
  if (!info.signedIn) return { state: "missing", stateNote: "Not signed in." };
  // A stale access token with a refresh token: the CLI refreshes it on its next use (Tether doesn't, to not race it).
  if (refused(usage) && info.refreshable) return { state: "unknown", stateNote: "Usage can't be read until the CLI next refreshes its login." };
  if (refused(usage))
    return {
      state: "expired",
      stateNote: `The login was refused (${usage!.error}). Sign in again.`,
    };
  return { state: "ok", ...(info.note ? { stateNote: info.note } : {}) };
}

const windowsOf = (u?: ProviderUsage): UsageWindow[] | undefined => (u && !u.error && u.windows.length ? u.windows : undefined);

// ---------------- models an extra account serves ----------------

/** The harness's own model list (adapters' listModels), loaded lazily; tests swap it. */
let modelSource = async (h: HarnessId): Promise<ModelRef[]> => {
  const mod =
    h === "claude-code"
      ? (await import("../adapters/claude")).claudeAdapter
      : h === "codex"
        ? (await import("../adapters/codex")).codexAdapter
        : (await import("../adapters/pi")).piAdapter;
  return (await mod.listModels()).models;
};
export function setModelSource(fn?: (h: HarnessId) => Promise<ModelRef[]>) {
  modelSource = fn ?? modelSource;
}

async function modelsFor(h: HarnessId, label: string, keep: (m: ModelRef) => boolean = () => true): Promise<CredentialModel[]> {
  try {
    const ms = await Promise.race([modelSource(h), Bun.sleep(15_000).then(() => [] as ModelRef[])]);
    return ms
      .filter((m) => !m.credential && m.id !== "default" && keep(m))
      .map((m) => ({
        harness: h,
        id: m.id,
        ...(m.label ? { label: m.label } : {}),
        ...(m.resolved ? { resolved: m.resolved } : {}),
        credentialLabel: label,
      }));
  } catch {
    return [];
  }
}

// ---------------- sign-in ----------------

function flowResult(flow: ReturnType<typeof flowFor>, message?: string): SignInResult {
  return {
    ...(flow ? { flow } : {}),
    ...(flow?.url ? { url: flow.url } : {}),
    ...(flow?.code ? { code: flow.code } : {}),
    ...((message ?? flow?.message) ? { message: message ?? flow?.message } : {}),
  };
}

/** Sign-ins started per credential: a cancelled flow cleans up only if no newer one took its place. */
const generation = new Map<string, number>();

/** Before a sign-in prepares anything: the earlier flow ends first (so its cleanup can't hit the new home). */
function beginSignIn(id: string): number {
  cancelFlow(id);
  const g = (generation.get(id) ?? 0) + 1;
  generation.set(id, g);
  return g;
}

/** After a sign-in ends: fresh state, and a new account whose sign-in never finished leaves no home behind. */
function afterSignIn(id: string, isNew: boolean, part?: Part, gen = generation.get(id)) {
  return (flow: { state: string }) => {
    forget(id);
    if (flow.state === "cancelled" && isNew && part && generation.get(id) === gen) {
      const signedIn =
        part === "claude"
          ? existsSync(join(partHome(id, "claude"), ".credentials.json"))
          : part === "codex"
            ? codexLogin(partHome(id, "codex")).signedIn
            : piLogin(partHome(id, "pi")).signedIn;
      if (!signedIn) {
        try {
          rmSync(accountHome(id), { recursive: true, force: true });
        } catch {}
      }
    }
  };
}

/** Flow actions every plugin answers: the state of its sign-in, the code you paste, cancel. */
async function flowAction(id: string, name: string, args: any): Promise<SignInResult | undefined> {
  if (name === "signInStatus") return flowResult(flowFor(id));
  if (name === "signInCode") return flowResult(await submitCode(id, String(args?.code ?? "")));
  if (name === "signInCancel") {
    const f = cancelFlow(id);
    return flowResult(f && { ...f, state: "cancelled" });
  }
  return undefined;
}

/**
 * Signing a machine login out: never one tap from the browser (it signs the CLI out for every
 * terminal too). The page shows the CLI's own command to run on the runner, and notices when it's done.
 */
function machineSignOut(id: string, command: string, what: string, signedIn: () => Promise<boolean> | boolean): SignInResult {
  beginSignIn(id);
  return flowResult(
    startCommand({
      id,
      command,
      message: `This signs ${what} out on the runner for everything, terminals included. To do it, run this there; Tether notices when it's done.`,
      check: async () => (forget(id), !(await signedIn())),
      onEnd: afterSignIn(id, false),
    }),
  );
}

/** Signs an extra account out (its home goes), saying where it was used: those entries are skipped from now on. */
async function signOutExtra(id: string): Promise<SignInResult> {
  const { defaultOrder } = await import("../defaultOrder");
  const used = usedIn(id, defaultOrder());
  removeAccountHome(id);
  return { message: used.length ? `Signed out. It was in ${used.join(", ")}: those entries are skipped until you sign in again or edit the order.` : "Signed out." };
}

/** A new extra account's id from the name you gave it. */
function newAccountId(provider: "claude" | "chatgpt", name: unknown): string {
  const slug = accountSlug(String(name ?? ""));
  if (!slug || !ACCOUNT_NAME.test(slug)) throw new Error("Give the account a short name (letters, digits, dots and dashes).");
  if (RESERVED_ACCOUNT_NAMES.includes(slug)) throw new Error(`“${slug}” is taken by this machine's own login. Pick another name.`);
  const id = `${provider}:${slug}`;
  if (existsSync(accountHome(id)) && !flowFor(id)) throw new Error(`There's already an account called “${slug}”.`);
  return id;
}

// ---------------- Claude ----------------

async function claudeSignIn(id: string, isNew: boolean): Promise<SignInResult> {
  const gen = beginSignIn(id);
  const dir = isMachine(id) ? undefined : preparedHome(id, "claude", true);
  const flow = await startRelay({
    id,
    kind: "paste",
    argv: [CLAUDE_BIN(), "auth", "login"],
    // No browser on the runner: Claude Code shows the link (and takes the code) instead.
    env: {
      ...(dir ? ownEnv({ CLAUDE_CONFIG_DIR: dir }) : process.env),
      BROWSER: "false",
    },
    cwd: userHome(),
    check: async () => {
      forget(id);
      return (await claudeLogin(dir)).signedIn;
    },
    onEnd: afterSignIn(id, isNew, "claude", gen),
  });
  return flowResult(flow);
}

export const claudePlugin: AccountPlugin = {
  provider: "claude",
  label: "Claude",
  actions: ["add"],
  async discover() {
    const out: CredentialView[] = [];
    const rows: [string, string | undefined][] = [["claude:machine", undefined], ...extraAccounts("claude").map((id): [string, string] => [id, partHome(id, "claude")])];
    await Promise.all(
      rows.map(async ([id, dir]) => {
        const info = await claudeLogin(dir);
        const usage = info.signedIn ? await rowUsage(id, dir ? { kind: "home", part: "claude", dir } : { kind: "machine", account: "claude" }) : undefined;
        const st = stateOf(info, usage);
        const label = accountLabel(info, dir ? id.slice("claude:".length) : "This machine's login");
        const actions = st.state !== "ok" ? ["signIn"] : dir ? [] : ["signOut"];
        out.push({
          id,
          kind: "login",
          provider: "anthropic",
          label,
          ...(info.email
            ? {
                account: [info.email, info.org && !info.org.includes(info.email) ? info.org : undefined].filter(Boolean).join(" · "),
              }
            : {}),
          source: dir ? "tether" : "cli",
          sourceNote: dir ? `Extra account “${id.slice(7)}” (its own Claude Code home)` : "Claude Code's own login on this machine",
          ...st,
          ...(windowsOf(usage) ? { usage: windowsOf(usage) } : {}),
          ...(dir && st.state === "ok" ? { models: await modelsFor("claude-code", label) } : {}),
          actions,
        });
      }),
    );
    return out;
  },
  homeFor(id, harness) {
    return harness === "claude-code" && !isMachine(id) ? partHome(id, "claude") : undefined;
  },
  async envFor(id) {
    if (isMachine(id)) return {};
    // The machine's token / endpoint variables would win over the account's login: blanked for this process.
    return { CLAUDE_CONFIG_DIR: preparedHome(id, "claude"), ...blanked("claude") };
  },
  async usage(id) {
    return freshUsage(isMachine(id) ? { kind: "machine", account: "claude" } : { kind: "home", part: "claude", dir: partHome(id, "claude") });
  },
  async test(id) {
    forget(id);
    const info = await claudeLogin(isMachine(id) ? undefined : partHome(id, "claude"));
    if (!info.signedIn) return { ok: false, result: "not signed in", message: "Not signed in." };
    const u = await this.usage!(id);
    if (refused(u))
      return {
        ok: false,
        result: "expired",
        message: `Claude refused the login (${u!.error}).`,
      };
    return {
      ok: true,
      result: "valid",
      message: `Signed in as ${info.email ?? "an account"}${info.plan ? ` (${planName(info.plan)})` : ""}.`,
    };
  },
  async action(id, name, args: any) {
    if (id === "claude" && name === "add") return claudeSignIn(newAccountId("claude", args?.name), true);
    const f = await flowAction(id, name, args);
    if (f) return f;
    if (name === "signIn") return claudeSignIn(id, false);
    if (name === "signOut") {
      if (!isMachine(id)) return signOutExtra(id);
      return machineSignOut(id, "claude auth logout", "Claude Code", async () => (await claudeLogin()).signedIn);
    }
    throw new Error(`Claude has no “${name}”.`);
  },
  async remove(id) {
    if (isMachine(id)) throw new Error("This machine's own login can't be removed here: sign out instead.");
    removeAccountHome(id);
  },
};

// ---------------- ChatGPT (Codex, pi) ----------------

async function codexSignIn(id: string, isNew: boolean): Promise<SignInResult> {
  const gen = beginSignIn(id);
  const home = id === "chatgpt:codex" ? undefined : preparedHome(id, "codex", true);
  const flow = await startRelay({
    id,
    kind: "device",
    argv: [CODEX_BIN(), "login", "--device-auth"],
    env: home ? ownEnv({ CODEX_HOME: home }) : process.env,
    cwd: userHome(),
    check: async () => codexLogin(home ?? machineCodexHome()).signedIn,
    onEnd: afterSignIn(id, isNew, "codex", gen),
  });
  return flowResult(flow);
}

/** pi has no sign-in command: its /login runs in its own screen. The page shows what to run. */
function piSignIn(id: string): SignInResult {
  beginSignIn(id);
  const dir = id === "chatgpt:pi" ? machinePiDir() : preparedHome(id, "pi", true);
  const command = id === "chatgpt:pi" ? PI_BIN() : `PI_CODING_AGENT_DIR=${dir.includes("'") ? JSON.stringify(dir) : `'${dir}'`} ${PI_BIN()}`;
  const flow = startCommand({
    id: `${id}`,
    command,
    message: "Run this on the runner, type /login and pick ChatGPT. Tether notices when you're signed in.",
    check: async () => piLogin(dir).signedIn,
    onEnd: afterSignIn(id, false),
  });
  return flowResult(flow);
}

export const chatgptPlugin: AccountPlugin = {
  provider: "chatgpt",
  label: "ChatGPT",
  actions: ["add"],
  async discover() {
    const out: CredentialView[] = [];
    const add = async (id: string, info: LoginInfo, u: UsageKey | undefined, v: Partial<CredentialView>, models: () => Promise<CredentialModel[]>) => {
      const usage = info.signedIn && u ? await rowUsage(id, u) : undefined;
      const st = stateOf(info, usage);
      const label = accountLabel(info, v.label ?? id);
      out.push({
        id,
        kind: "login",
        provider: "openai",
        source: "cli",
        ...v,
        label,
        ...(info.email ? { account: info.email } : {}),
        ...st,
        ...(windowsOf(usage) ? { usage: windowsOf(usage) } : {}),
        ...(st.state === "ok" ? { models: await models() } : {}),
      } as CredentialView);
    };
    const jobs: Promise<void>[] = [];
    if (installed(CODEX_BIN()) || existsSync(join(machineCodexHome(), "auth.json"))) {
      const info = codexLogin(machineCodexHome());
      jobs.push(
        add(
          "chatgpt:codex",
          info,
          { kind: "machine", account: "chatgpt:codex" },
          {
            label: "Codex on this machine",
            sourceNote: "The Codex CLI's own login on this machine",
            actions: [info.signedIn ? "signOut" : "signIn"],
          },
          async () => [],
        ),
      );
    }
    if (installed(PI_BIN()) || existsSync(join(machinePiDir(), "auth.json"))) {
      const info = piLogin(machinePiDir());
      jobs.push(
        add(
          "chatgpt:pi",
          info,
          { kind: "machine", account: "chatgpt:pi" },
          {
            label: "pi on this machine",
            sourceNote: "pi's own ChatGPT login (openai-codex) on this machine",
            actions: [info.signedIn ? "signOut" : "signIn"],
          },
          async () => [],
        ),
      );
    }
    for (const id of extraAccounts("chatgpt")) {
      const name = id.slice("chatgpt:".length);
      const codex = codexLogin(partHome(id, "codex"));
      const pi = piLogin(partHome(id, "pi"));
      const info: LoginInfo = codex.signedIn ? { ...codex, email: codex.email ?? pi.email } : pi;
      const u: UsageKey = codex.signedIn ? { kind: "home", part: "codex", dir: partHome(id, "codex") } : { kind: "home", part: "pi", dir: partHome(id, "pi") };
      const uses = [codex.signedIn && "Codex", pi.signedIn && "pi"].filter(Boolean).join(" and ");
      jobs.push(
        add(
          id,
          info,
          u,
          {
            label: name,
            source: "tether",
            sourceNote: `Extra account “${name}”${uses ? ` · signed in for ${uses}` : ""}`,
            actions: [...(codex.signedIn ? [] : ["signIn"]), ...(pi.signedIn ? [] : ["signInPi"])],
          },
          async () => {
            const label = accountLabel(info, name);
            return [...(codex.signedIn ? await modelsFor("codex", label) : []), ...(pi.signedIn ? await modelsFor("pi", label, (m) => m.id.startsWith("openai-codex/")) : [])];
          },
        ),
      );
    }
    await Promise.all(jobs);
    return out;
  },
  homeFor(id, harness) {
    if (isMachine(id)) return undefined;
    return harness === "codex" ? partHome(id, "codex") : harness === "pi" ? partHome(id, "pi") : undefined;
  },
  async envFor(id, entry: ChainEntry): Promise<Record<string, string>> {
    if (isMachine(id)) return {};
    if (entry.harness === "codex") return { CODEX_HOME: preparedHome(id, "codex"), ...blanked("codex") };
    if (entry.harness === "pi") return { PI_CODING_AGENT_DIR: preparedHome(id, "pi") };
    throw new Error(`${id} is a ChatGPT login: it runs Codex and pi, not ${entry.harness}.`);
  },
  async usage(id) {
    if (id === "chatgpt:codex") return freshUsage({ kind: "machine", account: "chatgpt:codex" });
    if (id === "chatgpt:pi") return freshUsage({ kind: "machine", account: "chatgpt:pi" });
    const codex = codexLogin(partHome(id, "codex")).signedIn;
    return freshUsage({
      kind: "home",
      part: codex ? "codex" : "pi",
      dir: partHome(id, codex ? "codex" : "pi"),
    });
  },
  async test(id) {
    forget(id);
    const u = await this.usage!(id);
    if (!u) return { ok: false, result: "not signed in", message: "Not signed in." };
    if (refused(u))
      return {
        ok: false,
        result: "expired",
        message: `ChatGPT refused the login (${u.error}).`,
      };
    if (u.error)
      return {
        ok: false,
        result: "unknown",
        message: `Couldn't check: ${u.error}`,
      };
    return {
      ok: true,
      result: "valid",
      message: `Signed in${u.plan ? ` (${planName(u.plan)})` : ""}.`,
    };
  },
  async action(id, name, args: any) {
    if (id === "chatgpt" && name === "add") return codexSignIn(newAccountId("chatgpt", args?.name), true);
    const f = await flowAction(id, name, args);
    if (f) return f;
    if (name === "signIn") return id === "chatgpt:pi" ? piSignIn(id) : codexSignIn(id, false);
    if (name === "signInPi" && !isMachine(id)) return piSignIn(id);
    if (name === "signOut") {
      if (!isMachine(id)) return signOutExtra(id);
      if (id === "chatgpt:pi") return machineSignOut(id, `${PI_BIN()}   # then type /logout and pick ChatGPT`, "pi's ChatGPT login", () => piLogin(machinePiDir()).signedIn);
      return machineSignOut(id, `${CODEX_BIN()} logout`, "the Codex CLI", () => codexLogin(machineCodexHome()).signedIn);
    }
    throw new Error(`ChatGPT has no “${name}”.`);
  },
  async remove(id) {
    if (isMachine(id)) throw new Error("This machine's own login can't be removed here: sign out instead.");
    removeAccountHome(id);
  },
};

// ---------------- Kiro, Antigravity (the machine's login only) ----------------

export const kiroPlugin: AccountPlugin = {
  provider: "kiro",
  label: "Kiro",
  async discover() {
    if (!installed(KIRO_BIN())) return [];
    const info = await kiroLogin();
    const usage = info.signedIn ? await rowUsage("kiro:machine", { kind: "machine", account: "kiro" }) : undefined;
    const st = stateOf(info, usage);
    return [
      {
        id: "kiro:machine",
        kind: "login",
        provider: "kiro",
        label: accountLabel({ ...info, plan: usage?.plan ?? info.plan }, "This machine's login"),
        ...(info.email ? { account: info.email } : {}),
        source: "cli",
        sourceNote: "kiro-cli's own login on this machine",
        ...st,
        ...(windowsOf(usage) ? { usage: windowsOf(usage) } : {}),
        actions: st.state === "ok" ? ["signOut"] : ["signIn"],
      },
    ];
  },
  homeFor: () => undefined,
  async envFor() {
    return {};
  },
  async usage() {
    return freshUsage({ kind: "machine", account: "kiro" });
  },
  async action(id, name, args) {
    const f = await flowAction(id, name, args);
    if (f) return f;
    if (name === "signIn")
      return flowResult(
        startCommand({
          id,
          command: `${KIRO_BIN()} login --use-device-flow`,
          message: "Run this on the runner and follow its link. Tether notices when you're signed in.",
          check: async () => (forget(id), (await kiroLogin()).signedIn),
          onEnd: afterSignIn(id, false),
        }),
      );
    if (name === "signOut") return machineSignOut(id, `${KIRO_BIN()} logout`, "kiro-cli", async () => (await kiroLogin()).signedIn);
    throw new Error(`Kiro has no “${name}”.`);
  },
  async remove() {
    throw new Error("This machine's own login can't be removed here: sign out instead.");
  },
};

export const antigravityPlugin: AccountPlugin = {
  provider: "antigravity",
  label: "Antigravity",
  async discover() {
    const signedIn = existsSync(agyToken());
    if (!signedIn && !installed(AGY_BIN())) return [];
    return [
      {
        id: "antigravity:machine",
        kind: "login",
        provider: "google",
        label: "This machine's login",
        source: "cli",
        sourceNote: "The Antigravity CLI's own Google login on this machine",
        ...stateOf({ signedIn }),
        actions: signedIn ? [] : ["signIn"],
      },
    ];
  },
  homeFor: () => undefined,
  async envFor() {
    return {};
  },
  async action(id, name, args) {
    const f = await flowAction(id, name, args);
    if (f) return f;
    if (name === "signIn")
      return flowResult(
        startCommand({
          id,
          command: AGY_BIN(),
          message: "Run this on the runner and sign in with Google. Tether notices when you're done.",
          check: async () => existsSync(agyToken()),
          onEnd: afterSignIn(id, false),
        }),
      );
    throw new Error(`Antigravity has no “${name}”.`);
  },
  async remove() {
    throw new Error("This machine's own login can't be removed here.");
  },
};

/** Registered by credentials/index.ts (slot accounts). */
export const accountPlugins: AccountPlugin[] = [claudePlugin, chatgptPlugin, kiroPlugin, antigravityPlugin];

/** Tests: forget cached logins and usage. */
export function resetAccountCaches() {
  statusCache.clear();
  usageCache.clear();
  usageInflight.clear();
}
