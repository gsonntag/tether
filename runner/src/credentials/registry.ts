// Credential provider plugins (.claude/credentials/SPEC.md, Stage 0): one plugin per provider
// ("azure", "bedrock", "anthropic"…) owns the credentials whose id starts "<provider>:". It finds
// them (Tether's store, the shell, a CLI's login), tests them, and gives a session's process what
// it needs: env and args from envFor/argsFor, asked once at process start (LiveSession.
// credentialLaunch, every adapter) for the session's "#credential". Only that credential's
// variables go into that process.
//
// Plugins are registered in credentials/index.ts, one line each. A plugin never sends a value to
// the app: views carry labels and last 4 chars at most (store.ts viewOf), the registry keeps only a
// view's known fields, turns an action's answer into a CredentialActionResult, and masks every
// known value in the messages it passes on (scrub).

import type {
  CredentialActionResult,
  CredentialList,
  CredentialModel,
  CredentialProviderInfo,
  CredentialTest,
  CredentialView,
} from "../../../web/src/shared/credentials";
import { credentialProvider, isCredentialId } from "../../../web/src/shared/credentials";
import { HARNESSES, parseEntry, type ChainEntry, type HarnessId, type ModelRef, type ProviderUsage, type UsageWindow } from "../../../web/src/shared/protocol";
import { config } from "../config";
import { setHarnessHomeResolver } from "../context/paths";
import { secretEnv } from "../secrets";
import * as store from "./store";

export interface CredentialPlugin {
  /** the id prefix it owns: "azure" owns "azure:east" */
  provider: string;
  /** "Microsoft Foundry": the Credentials page's group title */
  label: string;
  /** provider-level actions (credentialAction with id = provider), e.g. ["add"] */
  actions?: string[];
  /** every credential of this provider the runner can use: stored ones (store.views) and found ones */
  discover(): Promise<CredentialView[]>;
  /** one cheap call */
  test?(credId: string): Promise<CredentialTest>;
  /**
   * A provider-specific step ("signIn", "addModel", "add"…); `id` is a credential or the bare
   * provider. Answer with a CredentialActionResult (message, url, code, id, next); only those fields
   * reach the app, anything else is dropped.
   */
  action?(id: string, name: string, args: unknown): Promise<CredentialActionResult | unknown>;
  /**
   * Actions that only report how a step is going (a sign-in's "signInStatus", polled every few
   * seconds): they change nothing, so the list isn't rediscovered for them (credentialAction's op
   * answers the last one).
   */
  statusActions?: string[];
  /** the env a process running `entry` on this credential needs (only this credential's variables; see launchFor for the names allowed) */
  envFor(credId: string, entry: ChainEntry): Promise<Record<string, string>>;
  /**
   * Variable names this credential sets that the deny list (launchFor) would refuse, e.g. a Codex
   * provider's own `env_key`, which can be any name: allowed for it, except the ENV_NEVER ones
   * (PATH, HOME, LD_*, NODE_OPTIONS, TETHER_*…). Names outside the deny list need no declaring.
   */
  envNames?(credId: string): string[] | Promise<string[]>;
  /** extra command-line args for that process (Codex "-c k=v", pi "--provider"…) */
  argsFor?(credId: string, entry: ChainEntry): string[] | Promise<string[]>;
  /** the models it serves, per harness; absent: the view's own `models` */
  models?(credId: string): Promise<CredentialModel[]>;
  /** its usage now, for fallback's limit check (fallback.ts confirmLimit); absent: can't be checked */
  usage?(credId: string): Promise<ProviderUsage | undefined>;
  /** absent: store.remove (only stored credentials can be removed) */
  remove?(credId: string): Promise<void>;
  /**
   * The harness's own home for this credential, when it has one (an account's CLAUDE_CONFIG_DIR,
   * CODEX_HOME…, absolute): Tether reads that harness's native files there (transcripts, threads,
   * usage) for sessions on this credential. Absent / undefined: the machine's own (~/.claude…).
   */
  homeFor?(credId: string, harness: HarnessId): string | undefined;
}

const plugins = new Map<string, CredentialPlugin>();

/** Adds plugins (credentials/index.ts). A provider can have one plugin. */
export function register(...ps: CredentialPlugin[]) {
  for (const p of ps) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(p.provider)) throw new Error(`credential plugin "${p.provider}": a provider is lowercase letters, digits and dashes`);
    if (plugins.has(p.provider) && plugins.get(p.provider) !== p) throw new Error(`credential plugin "${p.provider}" is registered twice`);
    plugins.set(p.provider, p);
  }
  cached = undefined;
}

/** Tests: drop one plugin, or all (and what the registry remembered about them). */
export function unregister(provider?: string) {
  if (provider) plugins.delete(provider);
  else {
    plugins.clear();
    removed.clear();
    launched.clear();
  }
  cached = undefined;
  modelsRefresh = undefined;
}

export const registered = (): CredentialPlugin[] => [...plugins.values()];

/** The plugin that owns a credential id. */
export const pluginFor = (credId: string): CredentialPlugin | undefined => plugins.get(credentialProvider(credId));

// ---------------- what reaches the app ----------------

/** Values the app must never see in a message: Tether's stored ones, your secrets, what processes were given. */
const launched = new Set<string>();

/** `text` with every known value masked (an error or test message may quote a key). */
export function scrub(text: string): string {
  const known = new Set<string>(launched);
  for (const v of store.allValues()) known.add(v);
  for (const v of Object.values(secretEnv())) known.add(v);
  let out = text;
  for (const v of [...known].filter((v) => v.length >= 6).sort((a, b) => b.length - a.length)) out = out.split(v).join("••••");
  return out;
}

const errText = (e: any) => scrub(String(e?.message ?? e));

const str = (v: unknown, max = 300): string | undefined => (typeof v === "string" && v ? v.slice(0, max) : undefined);
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 120)) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const KINDS = new Set(["login", "apiKey", "awsProfile", "awsKeys"]);
const SOURCES = new Set(["tether", "shell", "env", "cli"]);
const STATES = new Set(["ok", "expired", "missing", "unknown"]);
const HARNESS_IDS = new Set<string>(HARNESSES.map((h) => h.id));

function cleanModel(m: any): CredentialModel | undefined {
  if (!m || typeof m !== "object" || typeof m.id !== "string" || !HARNESS_IDS.has(m.harness)) return undefined;
  const out: CredentialModel = { harness: m.harness, id: m.id.slice(0, 200) };
  for (const k of ["label", "resolved", "credentialLabel"] as const) if (str(m[k])) out[k] = str(m[k]);
  return out;
}

function cleanWindow(w: any): UsageWindow | undefined {
  if (!w || typeof w !== "object" || typeof w.label !== "string") return undefined;
  const out: UsageWindow = { label: w.label.slice(0, 80) };
  for (const k of ["percent", "resetsAt", "used", "limit"] as const) if (num(w[k]) !== undefined) (out as any)[k] = num(w[k]);
  return out;
}

/** Only a CredentialView's own fields, each its type: a plugin's extra fields (a token it carried along) never reach the app. */
export function cleanView(v: any): CredentialView | undefined {
  if (!v || typeof v !== "object" || typeof v.id !== "string" || !isCredentialId(v.id)) return undefined;
  const out: CredentialView = {
    id: v.id,
    kind: KINDS.has(v.kind) ? v.kind : "apiKey",
    provider: credentialProvider(v.id),
    label: str(v.label, 200) ?? v.id,
    source: SOURCES.has(v.source) ? v.source : "tether",
    state: STATES.has(v.state) ? v.state : "unknown",
  };
  for (const k of ["account", "endpointHost", "region", "sourceNote", "stateNote"] as const) if (str(v[k])) out[k] = scrub(str(v[k])!);
  if (typeof v.last4 === "string" && v.last4.length <= 4) out.last4 = v.last4;
  if (num(v.setAt) !== undefined) out.setAt = num(v.setAt);
  const models = Array.isArray(v.models) ? v.models.map(cleanModel).filter((m: CredentialModel | undefined): m is CredentialModel => !!m) : [];
  if (models.length) out.models = models;
  const usage = Array.isArray(v.usage) ? v.usage.map(cleanWindow).filter((w: UsageWindow | undefined): w is UsageWindow => !!w) : [];
  if (usage.length) out.usage = usage;
  if (strs(v.usedIn)?.length) out.usedIn = strs(v.usedIn);
  if (strs(v.actions)?.length) out.actions = strs(v.actions);
  return out;
}

/** An action's answer as the app may see it: the CredentialActionResult fields, an https URL only. */
export function cleanActionResult(r: any): CredentialActionResult | undefined {
  if (!r || typeof r !== "object") return undefined;
  const out: CredentialActionResult = {};
  if (str(r.message, 500)) out.message = scrub(str(r.message, 500)!);
  if (typeof r.url === "string" && /^https:\/\/[^\s]+$/.test(r.url) && r.url.length <= 4000) out.url = r.url;
  if (str(r.code, 64)) out.code = str(r.code, 64);
  const sug = strs(r.suggestions)?.filter(Boolean).slice(0, 500);
  if (sug?.length) out.suggestions = sug;
  if (typeof r.id === "string" && isCredentialId(r.id)) out.id = r.id;
  if (Array.isArray(r.models)) {
    const models = r.models
      .filter((m: any) => m && typeof m.id === "string" && m.id)
      .slice(0, 500)
      .map((m: any) => ({ id: m.id.slice(0, 200), ...(str(m.label) ? { label: str(m.label) } : {}), ...(HARNESS_IDS.has(m.harness) ? { harness: m.harness } : {}) }));
    if (models.length) out.models = models;
  }
  const n = r.next;
  if (n && typeof n === "object" && str(n.action, 64) && str(n.prompt, 200))
    out.next = { action: str(n.action, 64)!, prompt: str(n.prompt, 200)!, ...(str(n.field, 64) ? { field: str(n.field, 64) } : {}), ...(n.secret === true ? { secret: true } : {}) };
  return Object.keys(out).length ? out : undefined;
}

// ---------------- the list ----------------

const DISCOVER_MS = 20_000;

function timed<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`${what} took too long`)), ms)))]).finally(() => clearTimeout(t));
}

let cached: { at: number; list: CredentialList } | undefined;
const FRESH_MS = 15_000;

/** Credentials removed here since they were last listed: unavailable at once, before any list is fetched again. */
const removed = new Set<string>();

/**
 * Every plugin's credentials, grouped by provider in registration order. `order` (the default order)
 * fills each one's `usedIn` ("Default order #2"), and so do sessions on it ("2 sessions"). A plugin
 * that fails is listed in `errors`.
 */
export async function listCredentials(opts: { order?: string[] } = {}): Promise<CredentialList> {
  const providers: CredentialProviderInfo[] = [];
  const credentials: CredentialView[] = [];
  const errors: { provider: string; error: string }[] = [];
  await Promise.all(
    registered().map(async (p) => {
      providers.push({ provider: p.provider, label: p.label, ...(p.actions?.length ? { actions: p.actions } : {}) });
      try {
        const vs = await timed(p.discover(), DISCOVER_MS, `${p.label}`);
        for (const raw of Array.isArray(vs) ? vs : []) {
          const v = cleanView(raw);
          // A plugin lists only its own ids; anything else would route elsewhere.
          if (!v || credentialProvider(v.id) !== p.provider) continue;
          let models = v.models;
          if (p.models) models = await timed(p.models(v.id), DISCOVER_MS, `${p.label} models`).then((ms) => (Array.isArray(ms) ? ms.map(cleanModel).filter((m): m is CredentialModel => !!m) : v.models)).catch(() => v.models);
          const { models: _m, ...rest } = v;
          credentials.push({ ...rest, ...(models?.length ? { models } : {}) });
        }
      } catch (e: any) {
        errors.push({ provider: p.provider, error: errText(e) });
      }
    }),
  );
  const rank = new Map(registered().map((p, i) => [p.provider, i]));
  providers.sort((a, b) => rank.get(a.provider)! - rank.get(b.provider)!);
  credentials.sort((a, b) => rank.get(credentialProvider(a.id))! - rank.get(credentialProvider(b.id))! || a.label.localeCompare(b.label));
  for (const c of credentials) {
    removed.delete(c.id);
    const used = usedIn(c.id, opts.order);
    if (used.length) c.usedIn = [...(c.usedIn ?? []), ...used];
  }
  const list = { providers, credentials, ...(errors.length ? { errors } : {}) };
  cached = { at: Date.now(), list };
  return list;
}

/** "Default order #2" for each default-order entry on this credential, and "2 sessions" for sessions on it (or with it in their chain). */
export function usedIn(credId: string, order: string[] | undefined): string[] {
  const on = (e: string) => parseEntry(e, "claude-code").credential === credId;
  const out = (order ?? []).flatMap((e, i) => (on(e) ? [`Default order #${i + 1}`] : []));
  const sessions = Object.values(config().sessions ?? {}).filter((s) => s?.credential === credId || s?.chain?.some(on)).length;
  if (sessions) out.push(sessions === 1 ? "1 session" : `${sessions} sessions`);
  return out;
}

/** A credential's label for notices ("Switched to GPT-6 Luna · Azure"): the last list's, else its id. */
export function credentialLabel(credId: string): string {
  return cached?.list.credentials.find((c) => c.id === credId)?.label ?? store.get(credId)?.label ?? credId;
}

/** The last list, or a fresh one when it's older than a few seconds (entry checks before a save). */
async function recent(): Promise<CredentialList> {
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.list;
  return listCredentials();
}

/** The ids this runner has now (entryProblem's check before a default order or chain is saved). */
export async function credentialIds(): Promise<Set<string>> {
  if (!plugins.size) return new Set(store.ids());
  return new Set([...(await recent()).credentials.map((c) => c.id), ...store.ids()]);
}

/**
 * Whether an entry on this credential can run now: its plugin is on this runner and the credential
 * is still there (stored, or in the last list). Fallback, the default order and new sessions pass
 * over one that isn't, like a harness that isn't installed.
 */
export function credentialAvailable(credId: string): boolean {
  if (!pluginFor(credId)) return false;
  if (store.get(credId)) return true;
  if (removed.has(credId)) return false;
  return cached ? cached.list.credentials.some((c) => c.id === credId) : true;
}

/** An entry that can run as far as its credential goes (none: the harness's own login). */
export const entryAvailable = (e: ChainEntry) => !e.credential || credentialAvailable(e.credential);

let modelsRefresh: Promise<unknown> | undefined;
/** How long a model list waits for credentials never listed before; after that it answers without them. */
const FIRST_MODELS_MS = 2_000;

/**
 * Credential-backed models for one harness's model list: "gpt-6-luna" on "azure:east" reads
 * "GPT-6 Luna · <credentialLabel or the credential's label>". From the last list; a stale one is
 * refreshed in the background, so a picker never waits on discovery (only the very first time, briefly).
 */
export async function credentialModels(harness: HarnessId): Promise<ModelRef[]> {
  if (!plugins.size) return [];
  if (!cached || Date.now() - cached.at >= FRESH_MS) {
    const first = !cached;
    modelsRefresh ??= listCredentials()
      .catch(() => undefined)
      .finally(() => (modelsRefresh = undefined));
    if (first) await Promise.race([modelsRefresh, new Promise((r) => setTimeout(r, FIRST_MODELS_MS))]);
  }
  const out: ModelRef[] = [];
  for (const c of cached?.list.credentials ?? [])
    for (const m of c.models ?? [])
      if (m.harness === harness) {
        const { harness: _h, ...ref } = m;
        out.push({ ...ref, credential: c.id, credentialLabel: m.credentialLabel ?? c.label });
      }
  return out;
}

// ---------------- process start ----------------

export interface CredentialLaunch {
  /** goes over the runner's env and your secrets, under Tether's own (the guard's key) */
  env: Record<string, string>;
  /** appended to the harness's command line */
  args: string[];
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Always allowed: where a harness keeps its login, and the providers' own variables. */
const ENV_ALLOW = /^(CODEX_HOME|CLAUDE_CONFIG_DIR|CLAUDE_CODE_\w+|AWS_\w+|AZURE_\w+|ANTHROPIC_\w+|OPENAI_\w+|PI_\w+)$/;
/**
 * Never from a plugin: what decides which programs and code run (PATH, LD_*, NODE_OPTIONS…), where
 * home and config are, Tether's own (the guard's key), git's and ssh's, and proxies (a way out).
 */
const ENV_DENY =
  /^(PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|TMPDIR|TMP|TEMP|IFS|ENV|BASH_ENV|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|PS4|EDITOR|VISUAL|PAGER|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PERL5LIB|PERL5OPT|RUBYOPT|RUBYLIB|LD_\w*|DYLD_\w*|BUN_\w*|TETHER_\w*|GIT_\w*|SSH_\w*|XDG_\w*|BASH_FUNC_.*|SUDO_\w*|(HTTPS?|ALL|NO|FTP)_PROXY)$/i;

/** Never, not even when a plugin declares it (envNames): what runs code, home, Tether's own. */
const ENV_NEVER =
  /^(PATH|HOME|USER|LOGNAME|SHELL|IFS|ENV|BASH_ENV|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|PS4|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PERL5LIB|PERL5OPT|RUBYOPT|RUBYLIB|LD_\w*|DYLD_\w*|BUN_\w*|TETHER_\w*|BASH_FUNC_.*)$/i;

/**
 * Whether a plugin may set this variable for a process: explicit allows win over the deny list, and
 * so do the names the plugin declares for this credential (`declared`, CredentialPlugin.envNames: a
 * Codex provider's own env_key), except the ENV_NEVER ones.
 */
export const envNameAllowed = (k: string, declared: readonly string[] = []) =>
  ENV_NAME.test(k) && !ENV_NEVER.test(k) && (ENV_ALLOW.test(k) || !ENV_DENY.test(k) || declared.includes(k));

/**
 * What a process running `entry` needs from its credential (none without one). Throws when the
 * credential's plugin isn't on this runner: starting on the machine's own login instead would
 * quietly bill another account. A plugin's variable outside envNameAllowed refuses the start.
 */
export async function launchFor(entry: ChainEntry): Promise<CredentialLaunch> {
  const id = entry.credential;
  if (!id) return { env: {}, args: [] };
  const p = pluginFor(id);
  if (!p) throw new Error(`${id} isn't available on this runner (nothing handles “${credentialProvider(id) || id}” credentials).`);
  let env: Record<string, string>;
  let args: string[];
  let declared: string[];
  try {
    [env, args, declared] = await Promise.all([p.envFor(id, entry), p.argsFor?.(id, entry) ?? [], p.envNames?.(id) ?? []]);
  } catch (e: any) {
    throw new Error(`${p.label}: ${errText(e)}`);
  }
  for (const [k, v] of Object.entries(env ?? {})) {
    if (typeof v !== "string" || !ENV_NAME.test(k)) throw new Error(`${p.label}: bad environment variable ${k}`);
    if (!envNameAllowed(k, Array.isArray(declared) ? declared : [])) throw new Error(`${p.label}: a credential can't set ${k}`);
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new Error(`${p.label}: bad arguments`);
  for (const v of [...Object.values(env ?? {}), ...args]) if (v.length >= 6) launched.add(v);
  return { env: { ...env }, args: [...args] };
}

/** The harness's home for a credential (CredentialPlugin.homeFor), when its plugin keeps one. */
export function homeFor(credId: string | undefined, harness: HarnessId): string | undefined {
  if (!credId) return undefined;
  try {
    const h = pluginFor(credId)?.homeFor?.(credId, harness);
    return typeof h === "string" && h.startsWith("/") ? h : undefined;
  } catch {
    return undefined;
  }
}
setHarnessHomeResolver(homeFor);

/** The credential a stored or live session runs on (its saved prefs). */
export const sessionCredential = (sessionId: string): string | undefined => config().sessions?.[sessionId]?.credential;

/** Fresh usage for a credential, when its plugin reads it. */
export async function credentialUsage(credId: string): Promise<ProviderUsage | undefined> {
  return pluginFor(credId)?.usage?.(credId);
}

/** Whether fallback can check this credential's usage (else it never switches on its own). */
export const canCheckUsage = (credId: string) => !!pluginFor(credId)?.usage;

// ---------------- Credentials page ----------------

function owner(id: string): CredentialPlugin {
  const p = pluginFor(id) ?? plugins.get(id);
  if (!p) throw new Error(`Nothing on this runner handles ${id}.`);
  return p;
}

export async function testCredential(id: string): Promise<CredentialTest> {
  const p = owner(id);
  if (!p.test) return { ok: false, result: "untested", message: `${p.label} has no test.` };
  try {
    const t = await p.test(id);
    return { ok: t?.ok === true, result: scrub(str(t?.result, 80) ?? (t?.ok ? "valid" : "invalid")), ...(str(t?.message, 500) ? { message: scrub(str(t.message, 500)!) } : {}) };
  } catch (e: any) {
    return { ok: false, result: "error", message: errText(e) };
  }
}

/**
 * Removes a credential and answers where it was still used (default order, sessions): those
 * entries are passed over from now on (credentialAvailable), and the page said so next to Remove.
 */
export async function removeCredential(id: string, order?: string[]): Promise<{ usedIn: string[] }> {
  const p = owner(id);
  const used = usedIn(id, order);
  try {
    if (p.remove) await p.remove(id);
    else if (!(await store.remove(id))) throw new Error("Only keys stored in Tether can be removed here.");
  } catch (e: any) {
    throw new Error(errText(e));
  }
  removed.add(id);
  cached = undefined;
  return { usedIn: used };
}

/** Whether `action` only reports a step's state (CredentialPlugin.statusActions): no rediscovery for it. */
export const isStatusAction = (id: string, action: string) => {
  const p = pluginFor(id) ?? plugins.get(id);
  return !!p?.statusActions?.includes(action);
};

/** The last list, as it is (no discovery): what a status action answers with. */
export const lastCredentialList = (): CredentialList | undefined => cached?.list;

/** A provider-specific step; `id` is a credential or a bare provider ("azure" + "add"). */
export async function credentialAction(id: string, action: string, args: unknown): Promise<CredentialActionResult | undefined> {
  const p = owner(id);
  if (!p.action) throw new Error(`${p.label} has no “${action}”.`);
  let r: unknown;
  try {
    r = await p.action(id, action, args);
  } catch (e: any) {
    throw new Error(errText(e));
  } finally {
    if (!isStatusAction(id, action)) cached = undefined;
  }
  if (typeof r === "object" && r && "id" in r && typeof (r as any).id === "string") removed.delete((r as any).id);
  return cleanActionResult(r);
}
