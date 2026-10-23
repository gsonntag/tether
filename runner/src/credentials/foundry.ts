// Microsoft Foundry (Azure OpenAI) keys, for GPT models through Codex and pi
// (.claude/credentials/SPEC.md sections 5 and 5a).
//
// One credential per Azure resource ("azure:east-coast-gavin-resource"); the key belongs to the
// resource, its models are deployment names. Two ways in, one code path:
// - Codex-native: a `[model_providers.<id>]` in $CODEX_HOME/config.toml whose base_url is an Azure
//   host, with profiles ($CODEX_HOME/<name>.config.toml, or legacy [profiles.<name>]) using it. Each
//   profile's model is a model entry ("GPT-6.1 Sol · Azure").
// - Tether-native: endpoint + key (+ label) from the Credentials page, kept in Tether's store.
// Either way a Codex process gets `-c` overrides (codex app-server has no `-p`): the provider (the
// user's own, or one defined on the command line for a Tether-native key), the model, and the rest
// of that model's profile (model_reasoning_effort…). pi gets AZURE_OPENAI_BASE_URL and the key.
//
// The key, in order: Tether's store; the runner's env; the user's login shell (only that variable,
// `bash -lic`, cached, never logged). Values never leave the runner.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CredentialActionResult, CredentialModel, CredentialSource, CredentialTest, CredentialView } from "../../../web/src/shared/credentials";
import type { ChainEntry } from "../../../web/src/shared/protocol";
import type { CredentialPlugin } from "./registry";
import * as store from "./store";

export const PROVIDER = "azure";
/** pi extension that makes the session's key win over pi's own stored azure key (runner/hooks/pi-azure-key.ts). */
export const PI_AZURE_EXT = fileURLToPath(new URL("../../hooks/pi-azure-key.ts", import.meta.url));
const DEFAULT_ENV_KEY = "AZURE_OPENAI_API_KEY";
/** The Codex provider id Tether defines on the command line for a key that has no Codex config. */
export const TETHER_CODEX_PROVIDER = "tether-azure";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEPLOYMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AZURE_HOST = /\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com|ai\.azure\.com)$/i;

type Scalar = string | number | boolean;

/** A Codex profile on an Azure provider: `codex -p <name>`. */
export interface CodexProfile {
  name: string;
  model: string;
  /** its other top-level settings (model_reasoning_effort…), passed as `-c` */
  overrides: Record<string, Scalar>;
}

/** A `[model_providers.<id>]` pointing at Azure, with the profiles that use it. */
export interface CodexAzureProvider {
  id: string;
  baseUrl: string;
  envKey: string;
  wireApi: string;
  query?: Record<string, string>;
  profiles: CodexProfile[];
}

/** One model entry of a resource. */
interface Deployment {
  deployment: string;
  profile?: CodexProfile;
}

/** One Azure resource, merged from Codex's config and Tether's store. */
interface Resource {
  id: string;
  host: string;
  baseUrl: string;
  label: string;
  envKey: string;
  wireApi: string;
  query?: Record<string, string>;
  codex?: CodexAzureProvider;
  stored?: store.StoredCredential;
  /**
   * Model entries by their id: the deployment name, or "<deployment>@<profile>" for a second Codex
   * profile on the same deployment with other settings (e.g. another effort). No profile: added in Tether.
   */
  deployments: Map<string, Deployment>;
}

// ---------------- Codex config ----------------

const home = () => process.env.HOME || "/";
export const codexHome = () => process.env.CODEX_HOME || join(home(), ".codex");

function readToml(path: string): Record<string, any> | undefined {
  try {
    return Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, any>;
  } catch {
    return undefined;
  }
}

/** "https://east.openai.azure.com/openai/v1" → its host, when it parses as https. */
function hostOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

const isAzureProvider = (p: any) => {
  const host = typeof p?.base_url === "string" ? hostOf(p.base_url) : undefined;
  return !!host && (AZURE_HOST.test(host) || /azure|foundry/i.test(String(p?.name ?? "")));
};

function profileOf(name: string, t: Record<string, any> | undefined, providers: Set<string>): (CodexProfile & { provider: string }) | undefined {
  if (!t || typeof t.model !== "string" || typeof t.model_provider !== "string" || !providers.has(t.model_provider)) return undefined;
  const overrides: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(t)) if (k !== "model_provider" && k !== "model" && /^[A-Za-z0-9_]+$/.test(k) && (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))) overrides[k] = v as Scalar;
  return { name, model: t.model, overrides, provider: t.model_provider };
}

/** The Azure providers in $CODEX_HOME/config.toml and the profiles on them. */
export function codexAzureProviders(dir = codexHome()): CodexAzureProvider[] {
  const config = readToml(join(dir, "config.toml"));
  if (!config) return [];
  const out = new Map<string, CodexAzureProvider>();
  for (const [id, p] of Object.entries((config.model_providers ?? {}) as Record<string, any>)) {
    if (!isAzureProvider(p)) continue;
    const envKey = typeof p.env_key === "string" && ENV_NAME.test(p.env_key) ? p.env_key : DEFAULT_ENV_KEY;
    const query = p.query_params && typeof p.query_params === "object" ? Object.fromEntries(Object.entries(p.query_params).filter((e): e is [string, string] => typeof e[1] === "string")) : undefined;
    out.set(id, { id, baseUrl: String(p.base_url).replace(/\/+$/, ""), envKey, wireApi: p.wire_api === "chat" ? "chat" : "responses", ...(query && Object.keys(query).length ? { query } : {}), profiles: [] });
  }
  if (!out.size) return [];
  const ids = new Set(out.keys());
  const add = (p: ReturnType<typeof profileOf>) => p && out.get(p.provider)!.profiles.push({ name: p.name, model: p.model, overrides: p.overrides });
  // codex-cli 0.164: `-p <name>` layers $CODEX_HOME/<name>.config.toml over config.toml.
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^[^.].*\.config\.toml$/.test(f)).sort();
  } catch {}
  for (const f of files) add(profileOf(f.slice(0, -".config.toml".length), readToml(join(dir, f)), ids));
  // Older Codex: [profiles.<name>] tables in config.toml.
  for (const [name, t] of Object.entries((config.profiles ?? {}) as Record<string, any>)) add(profileOf(name, t, ids));
  // config.toml's own model, when it runs on one of them.
  if (typeof config.model_provider === "string" && ids.has(config.model_provider) && typeof config.model === "string")
    out.get(config.model_provider)!.profiles.push({ name: "config.toml", model: config.model, overrides: {} });
  return [...out.values()];
}

// ---------------- the key ----------------

let shellMs = 8_000;
const MARK = "\u001eTETHER\u001e";
/** What a reader returns when the shell didn't answer in time (not cached: the next ask tries again). */
export const SHELL_TIMEOUT = Symbol("shell timeout");

/** The value between the two marks, "" for an empty one, undefined until both are there. */
function marked(out: string): string | undefined {
  const a = out.indexOf(MARK);
  const b = a >= 0 ? out.indexOf(MARK, a + MARK.length) : -1;
  return b > a ? out.slice(a + MARK.length, b) : undefined;
}

/** How the login shell is read (tests swap it): the value, undefined, or SHELL_TIMEOUT. */
type ShellReader = (name: string) => Promise<string | undefined | typeof SHELL_TIMEOUT>;

/**
 * `bash -lic`, only that variable (by indirection: the name never goes into the script). It answers
 * as soon as the value is printed, not when stdout closes: a background job an rc file starts
 * (`sleep 600 &`) keeps stdout open. `setsid` makes bash lead its own process group, and the whole
 * group is killed when it has answered or after the timeout.
 */
const bashReader: ShellReader = (name) =>
  new Promise((resolve) => {
    const env: Record<string, string> = { TETHER_SHELL_VAR: name, TERM: "dumb" };
    for (const k of ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG"]) if (process.env[k]) env[k] = process.env[k]!;
    let p: ReturnType<typeof Bun.spawn>;
    try {
      p = Bun.spawn(["setsid", "bash", "-lic", `printf '${MARK}%s${MARK}' "\${!TETHER_SHELL_VAR}"`], { env, cwd: home(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    } catch {
      return resolve(undefined);
    }
    let done = false;
    const finish = (v: string | undefined | typeof SHELL_TIMEOUT) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        process.kill(-p.pid, "SIGKILL");
      } catch {}
      p.kill(9);
      resolve(v);
    };
    const timer = setTimeout(() => finish(SHELL_TIMEOUT), shellMs);
    (async () => {
      const dec = new TextDecoder();
      let out = "";
      try {
        for await (const chunk of p.stdout as ReadableStream<Uint8Array>) {
          out = (out + dec.decode(chunk, { stream: true })).slice(-200_000);
          const v = marked(out);
          if (v !== undefined) return finish(v || undefined);
        }
      } catch {}
      finish(marked(out) || undefined);
    })();
  });

let shellReader: ShellReader = bashReader;
const shellCache = new Map<string, { at: number; value?: string; pending?: Promise<string | undefined> }>();
/** Found or missing, until asked again on demand (Test, Store in Tether, a session start…) or 30 min. */
const SHELL_CACHE_MS = 30 * 60_000;

/** Tests: read the shell with `fn` (absent: bash again) and this timeout, and forget what was read. */
export function setShellReader(fn?: ShellReader, timeoutMs = 8_000) {
  shellReader = fn ?? bashReader;
  shellMs = timeoutMs;
  shellCache.clear();
}

/** Forget what the shell said for `name` (Test, Remove, Store in Tether, Replace key). */
export function forgetShell(name: string) {
  if (!shellCache.get(name)?.pending) shellCache.delete(name);
}

/**
 * One variable from the login shell, cached for 30 min, a missing one too (no login shell every few
 * minutes). `fresh` (on demand: a session start, an action): a missing one is asked again. A shell
 * that times out isn't cached and never holds up the next ask.
 */
export async function shellVar(name: string, fresh = false): Promise<string | undefined> {
  if (!ENV_NAME.test(name)) return undefined;
  const c = shellCache.get(name);
  if (c?.pending) return c.pending;
  if (c && Date.now() - c.at < SHELL_CACHE_MS && (c.value || !fresh)) return c.value;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A reader that never answers (a test's, a stuck spawn) times out here too.
  const guard = new Promise<typeof SHELL_TIMEOUT>((res) => (timer = setTimeout(() => res(SHELL_TIMEOUT), shellMs + 2_000)));
  const pending = Promise.race([shellReader(name).catch(() => undefined), guard]).then((v) => {
    clearTimeout(timer);
    if (v === SHELL_TIMEOUT) {
      shellCache.delete(name);
      return undefined;
    }
    shellCache.set(name, { at: Date.now(), value: v });
    return v;
  });
  shellCache.set(name, { at: 0, pending });
  return pending;
}

/** "From ~/.bashrc" when a startup file exports it. */
function shellFile(name: string): string | undefined {
  const re = new RegExp(`(^|[\\s;])(export\\s+)?${name}(=|\\s*$|\\s)`, "m");
  for (const f of [".bashrc", ".bash_profile", ".bash_login", ".profile"]) {
    try {
      if (re.test(readFileSync(join(home(), f), "utf8"))) return `~/${f}`;
    } catch {}
  }
  return undefined;
}

interface Key {
  value?: string;
  source: CredentialSource;
  note?: string;
}

/** The host a stored record is for: a stored key goes only to that host. */
const storedHost = (c: store.StoredCredential | undefined) => c && (c.endpointHost ?? (typeof c.meta?.baseUrl === "string" ? hostOf(c.meta.baseUrl) : undefined));

/** `fresh`: ask the shell again when it had nothing (on demand: Test, a session start, an action). */
async function keyOf(r: Resource, fresh = false): Promise<Key> {
  const stored = storedHost(r.stored) === r.host ? r.stored?.values.apiKey : undefined;
  if (stored) return { value: stored, source: "tether" };
  const env = process.env[r.envKey];
  if (env) return { value: env, source: "env", note: `From the runner's environment (${r.envKey})` };
  const shell = await shellVar(r.envKey, fresh);
  if (shell) {
    const f = shellFile(r.envKey);
    return { value: shell, source: "shell", note: f ? `From ${f}` : `From your login shell (${r.envKey})` };
  }
  return { source: r.codex ? "cli" : "tether" };
}

// ---------------- resources ----------------

/** "east-coast-gavin-resource.openai.azure.com" → "azure:east-coast-gavin-resource". */
export function resourceId(host: string): string {
  const name = host.split(".")[0]!.replace(/[^A-Za-z0-9._@+-]/g, "-").slice(0, 96) || "resource";
  return `${PROVIDER}:${name}`;
}

/**
 * What someone types as the endpoint → the v1 base URL: a resource name, a host, the portal's
 * "https://x.openai.azure.com/", or a full ".../openai/v1".
 */
export function normalizeEndpoint(input: string): string {
  let s = input.trim().replace(/\/+$/, "");
  if (!s) throw new Error("Give the endpoint, e.g. https://<resource>.openai.azure.com");
  if (/^[a-z0-9][a-z0-9-]{1,62}$/i.test(s)) s = `https://${s}.openai.azure.com`;
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error("That endpoint isn't a URL.");
  }
  if (u.protocol !== "https:") throw new Error("The endpoint has to be https.");
  if (u.username || u.password) throw new Error("Leave credentials out of the endpoint; the key goes in its own field.");
  const path = u.pathname.replace(/\/+$/, "");
  if (["", "/openai", "/openai/v1/responses", "/openai/v1/chat/completions"].includes(path) || /^\/api\/projects\//.test(path)) u.pathname = "/openai/v1";
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/+$/, "");
}

interface Meta {
  baseUrl?: string;
  deployments?: string[];
}

const metaOf = (c: store.StoredCredential | undefined): Meta => (c?.meta ?? {}) as Meta;

/** Every resource: Codex's Azure providers, then Tether's stored ones (same resource: one row). */
export function resources(): Resource[] {
  const byId = new Map<string, Resource>();
  for (const p of codexAzureProviders()) {
    const host = hostOf(p.baseUrl)!;
    let id = resourceId(host);
    // A key stored for another host under this name never goes to this one: this provider gets its own id.
    const other = storedHost(store.get(id));
    if ((other && other !== host) || (byId.has(id) && byId.get(id)!.host !== host)) id = resourceId(`${host.split(".")[0]}-${p.id}`);
    const r = byId.get(id) ?? { id, host, baseUrl: p.baseUrl, label: id.slice(PROVIDER.length + 1), envKey: p.envKey, wireApi: p.wireApi, ...(p.query ? { query: p.query } : {}), codex: p, deployments: new Map() };
    // By name: "azure-luna" keeps the plain id, "azure-luna-low" gets "@azure-luna-low".
    for (const pr of [...p.profiles].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const same = [...r.deployments.values()].filter((d) => d.deployment === pr.model);
      // The same deployment with the same settings is one entry; other settings (an effort) another.
      if (same.some((d) => JSON.stringify(d.profile?.overrides ?? {}) === JSON.stringify(pr.overrides))) continue;
      if (same.length && !/^[A-Za-z0-9._-]{1,64}$/.test(pr.name)) continue;
      r.deployments.set(same.length ? `${pr.model}@${pr.name}` : pr.model, { deployment: pr.model, profile: pr });
    }
    byId.set(id, r);
  }
  for (const id of store.ids(PROVIDER)) {
    const c = store.get(id)!;
    const m = metaOf(c);
    let r = byId.get(id);
    if (r && storedHost(c) !== r.host) continue;
    if (!r) {
      if (!m.baseUrl) continue;
      const host = hostOf(m.baseUrl);
      if (!host) continue;
      r = { id, host, baseUrl: m.baseUrl, label: host.split(".")[0]!, envKey: DEFAULT_ENV_KEY, wireApi: "responses", deployments: new Map() };
      byId.set(id, r);
    }
    r.stored = c;
    if (c.label) r.label = c.label;
    for (const d of m.deployments ?? []) if (![...r.deployments.values()].some((x) => x.deployment === d)) r.deployments.set(d, { deployment: d });
  }
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
}

const resource = (id: string) => resources().find((r) => r.id === id);

function mustResource(id: string): Resource {
  const r = resource(id);
  if (!r) throw new Error(`${id} isn't on this runner any more.`);
  return r;
}

/** "Azure", or "Azure · <label>" when there are several. */
const shortName = (r: Resource, all: Resource[]) => (all.length > 1 ? `Azure · ${r.label}` : "Azure");

function modelsOf(r: Resource, all: Resource[]): CredentialModel[] {
  const credentialLabel = shortName(r, all);
  const out: CredentialModel[] = [];
  const pi = new Set<string>();
  for (const [id, { deployment, profile }] of r.deployments) {
    // label: the Codex profile it came from (searchable in pickers; the Credentials row shows it). None: added in Tether.
    out.push({ harness: "codex", id, credentialLabel, ...(profile ? { label: profile.name } : {}) });
    // pi has no profiles: one entry per deployment.
    if (!pi.has(deployment)) out.push({ harness: "pi", id: `azure/${deployment}`, credentialLabel, ...(profile ? { label: profile.name } : {}) });
    pi.add(deployment);
  }
  return out;
}

// ---------------- Azure calls ----------------

/** fetch, swappable in tests. */
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (url, init) => fetch(url, init);
export function setFetch(fn?: Fetcher) {
  fetcher = fn ?? ((url, init) => fetch(url, init));
}

const CALL_MS = 30_000;

function urlOf(r: { baseUrl: string; query?: Record<string, string> }, path: string): string {
  const u = new URL(r.baseUrl.replace(/\/+$/, "") + path);
  for (const [k, v] of Object.entries(r.query ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

async function errorOf(res: Response): Promise<{ code?: string; message: string }> {
  const text = await res.text().catch(() => "");
  try {
    const e = JSON.parse(text)?.error;
    if (e) return { code: typeof e.code === "string" ? e.code : undefined, message: String(e.message ?? "").slice(0, 300) };
  } catch {}
  return { message: text.slice(0, 300) };
}

/**
 * An Azure answer as Test reports it. 429s: Azure's per-deployment token/request rate (the usual
 * one, "exceeded token rate limit … retry after N seconds") is a rate limit, the key works;
 * insufficient_quota / an exceeded quota is a quota. Its links (aka.ms/oai/quotaincrease) don't count.
 */
export function azureResult(status: number, err: { code?: string; message: string }, deployment?: string): CredentialTest {
  const what = deployment ? `“${deployment}”` : "The key";
  if (status >= 200 && status < 300) return { ok: true, result: "valid" };
  const words = `${err.code ?? ""} ${err.message}`.replace(/https?:\/\/\S+/g, "");
  if (status === 401 || status === 403) return { ok: false, result: "invalid", message: `Azure didn't accept the key${err.code ? ` (${err.code})` : ""}.` };
  if (status === 404 && (/DeploymentNotFound|deployment/i.test(words) || deployment))
    return { ok: false, result: "wrong deployment", message: `${what} isn't a deployment on this resource.` };
  if (status === 429) {
    if (/insufficient_quota|exceeded your current quota|quota exceeded|out of credits|billing/i.test(words)) return { ok: false, result: "quota", message: `${what}: out of quota.` };
    const after = words.match(/retry after (\d+) seconds?/i)?.[1];
    return { ok: true, result: "rate limited", message: `${what} works; Azure is rate-limiting it right now${after ? ` (retry after ${after}s)` : ""}.` };
  }
  return { ok: false, result: "error", message: `${what}: Azure said ${status}${err.message ? `: ${err.message}` : ""}.` };
}

/** One tiny call on a deployment (16 output tokens at most). */
export async function tinyCall(r: { baseUrl: string; query?: Record<string, string>; wireApi?: string }, key: string, deployment: string): Promise<CredentialTest> {
  const chat = r.wireApi === "chat";
  const body = chat ? { model: deployment, messages: [{ role: "user", content: "Say OK." }], max_completion_tokens: 16 } : { model: deployment, input: "Say OK.", max_output_tokens: 16, store: false };
  try {
    const res = await fetcher(urlOf(r, chat ? "/chat/completions" : "/responses"), {
      method: "POST",
      headers: { "api-key": key, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_MS),
    });
    if (res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: true, result: "valid" };
    }
    return azureResult(res.status, await errorOf(res), deployment);
  } catch (e: any) {
    return { ok: false, result: "unreachable", message: `Couldn't reach ${hostOf(r.baseUrl) ?? "Azure"}${e?.name === "TimeoutError" ? " (timed out)" : ""}.` };
  }
}

/**
 * Suggestions first where Codex and pi run best: OpenAI's GPT, then codex, then o-series models, newest
 * first ("gpt-6.1-sol" before "gpt-4o"), undated before dated snapshots; then the rest A–Z.
 */
export function suggestionOrder(names: string[]): string[] {
  const rank = (n: string) => (/^gpt/i.test(n) ? 0 : /^codex/i.test(n) ? 1 : /^o\d/i.test(n) ? 2 : 3);
  const dated = (n: string) => /-\d{4}-\d{2}-\d{2}$/.test(n);
  return [...names].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (rank(a) === 3) return a.localeCompare(b);
    if (dated(a) !== dated(b)) return dated(a) ? 1 : -1;
    return b.localeCompare(a, undefined, { numeric: true });
  });
}

/** GET <base>/models: the resource's model names, where the key can read them (suggestions only). */
export async function listAzureModels(r: { baseUrl: string; query?: Record<string, string> }, key: string): Promise<{ status: number; models: string[] }> {
  try {
    const res = await fetcher(urlOf(r, "/models"), { headers: { "api-key": key }, signal: AbortSignal.timeout(CALL_MS) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, models: [] };
    }
    const data: any[] = (await res.json().catch(() => ({})))?.data ?? [];
    const names = data
      .filter((m) => typeof m?.id === "string" && m.capabilities?.chat_completion !== false && !/embedding|whisper|dall-e|tts|transcribe|image|realtime|audio/i.test(m.id))
      .map((m) => m.id as string);
    return { status: res.status, models: suggestionOrder([...new Set(names)]) };
  } catch {
    return { status: 0, models: [] };
  }
}

// ---------------- the plugin ----------------

async function viewOf(r: Resource, all: Resource[]): Promise<CredentialView> {
  const key = await keyOf(r);
  const removable = [...r.deployments.values()].some((d) => !d.profile);
  const actions = [key.value && key.source !== "tether" ? "storeKey" : undefined, "addModel", key.source === "tether" ? "replaceKey" : undefined, removable ? "removeModel" : undefined].filter(Boolean) as string[];
  const last4 = key.value && key.value.length >= 8 ? key.value.slice(-4) : undefined;
  return {
    id: r.id,
    kind: "apiKey",
    provider: PROVIDER,
    label: r.label,
    endpointHost: r.host,
    ...(last4 ? { last4 } : {}),
    source: key.source,
    ...(key.note ? { sourceNote: key.note } : {}),
    state: key.value ? "ok" : "missing",
    ...(key.value ? {} : { stateNote: noKey(r) }),
    ...(r.stored?.values.apiKey ? { setAt: r.stored.setAt } : {}),
    models: modelsOf(r, all),
    actions,
  };
}

/** Why there's no key, in words. */
const noKey = (r: Resource) => `No key found (not in Tether, the runner env, or ~/.bashrc as ${r.envKey}).`;

async function keyFor(r: Resource): Promise<string> {
  const k = (await keyOf(r, true)).value;
  if (!k) throw new Error(`${r.label}: ${noKey(r)} Add it on the Credentials page.`);
  return k;
}

const toml = (v: Scalar) => (typeof v === "string" ? JSON.stringify(v) : String(v));

/** The `-c` overrides that put a Codex process on this resource, running `model`. */
export function codexArgs(r: Pick<Resource, "codex" | "baseUrl" | "wireApi" | "query" | "deployments">, model: string): string[] {
  const c = (k: string, v: Scalar) => ["-c", `${k}=${toml(v)}`];
  const args: string[] = [];
  let provider: string;
  if (r.codex) provider = r.codex.id;
  else {
    // A key with no Codex config: the same provider shape, defined for this process only.
    provider = TETHER_CODEX_PROVIDER;
    const at = `model_providers.${provider}`;
    args.push(...c(`${at}.name`, "Microsoft Foundry"), ...c(`${at}.base_url`, r.baseUrl), ...c(`${at}.env_key`, DEFAULT_ENV_KEY), ...c(`${at}.wire_api`, r.wireApi));
    for (const [k, v] of Object.entries(r.query ?? {})) if (/^[A-Za-z0-9_-]+$/.test(k)) args.push(...c(`${at}.query_params.${k}`, v));
  }
  args.push(...c("model_provider", provider));
  const d = r.deployments.get(model);
  const deployment = d?.deployment ?? model.replace(/@[^@]*$/, "");
  if (deployment && deployment !== "default") args.push(...c("model", deployment));
  // The rest of the model's profile, as `codex -p <name>` would layer it.
  for (const [k, v] of Object.entries(d?.profile?.overrides ?? {})) args.push(...c(k, v));
  return args;
}

async function storeKey(r: Resource, apiKey: string, extra: Partial<Meta> = {}) {
  const m = metaOf(r.stored);
  await store.put({
    id: r.id,
    kind: "apiKey",
    label: r.stored?.label ?? r.label,
    values: { apiKey },
    last4Of: "apiKey",
    endpointHost: r.host,
    meta: { ...m, baseUrl: m.baseUrl ?? r.baseUrl, ...extra },
  });
}

/** A key Azure refuses outright isn't stored; anything else (models unreadable, offline) is, and Test says more. */
async function checkKey(r: { baseUrl: string; query?: Record<string, string> }, key: string) {
  const { status } = await listAzureModels(r, key);
  if (status === 401 || status === 403) throw new Error(`Azure didn't accept that key for ${hostOf(r.baseUrl)}.`);
}

export const foundryPlugin: CredentialPlugin = {
  provider: PROVIDER,
  label: "Microsoft Foundry",
  actions: ["add"],

  async discover() {
    const all = resources();
    return Promise.all(all.map((r) => viewOf(r, all)));
  },

  async test(id) {
    const r = mustResource(id);
    // Test reads the shell again: it may have changed since it was last asked.
    forgetShell(r.envKey);
    const key = (await keyOf(r, true)).value;
    if (!key) return { ok: false, result: "missing", message: noKey(r) };
    const ds = [...new Set([...r.deployments.values()].map((d) => d.deployment))];
    if (!ds.length) {
      const { status, models } = await listAzureModels(r, key);
      if (status === 401 || status === 403) return azureResult(status, { message: "" });
      return { ok: true, result: "valid", message: status === 200 ? `The key works (${models.length} models on the resource). Add a model to use it.` : "No models yet. Add one to test it." };
    }
    const results = await Promise.all(ds.map(async (d) => ({ d, t: await tinyCall(r, key, d) })));
    const bad = results.filter((x) => !x.t.ok);
    if (!bad.length) {
      const limited = results.find((x) => x.t.result === "rate limited");
      return { ok: true, result: limited ? "rate limited" : "valid", message: limited?.t.message ?? (ds.length === 1 ? "Works." : `All ${ds.length} models answer.`) };
    }
    const first = bad[0]!.t;
    return { ok: false, result: first.result, message: bad.map((x) => x.t.message ?? `“${x.d}”: ${x.t.result}`).join(" ") };
  },

  async action(id, name, args) {
    const a = (args ?? {}) as { endpoint?: string; apiKey?: string; label?: string; deployment?: string };
    if (id === PROVIDER && name === "add") {
      const baseUrl = normalizeEndpoint(String(a.endpoint ?? ""));
      const apiKey = String(a.apiKey ?? "").trim();
      if (!apiKey) throw new Error("Paste the key.");
      const host = hostOf(baseUrl)!;
      const cid = resourceId(host);
      const existing = resource(cid);
      if (existing?.stored?.values.apiKey) throw new Error(`${existing.label} is already here: use Replace key on it.`);
      await checkKey({ baseUrl: existing?.baseUrl ?? baseUrl, query: existing?.query }, apiKey);
      const label = String(a.label ?? "").trim().slice(0, 60);
      const r: Resource = existing ?? { id: cid, host, baseUrl, label: label || host.split(".")[0]!, envKey: DEFAULT_ENV_KEY, wireApi: "responses", deployments: new Map() };
      if (label) r.label = label;
      await store.put({ id: cid, kind: "apiKey", label: r.label, values: { apiKey }, last4Of: "apiKey", endpointHost: host, meta: { ...metaOf(existing?.stored), baseUrl: r.baseUrl } });
      return { id: cid, message: `Added ${r.label}. Add a model to use it.` } satisfies CredentialActionResult;
    }
    const r = mustResource(id);
    switch (name) {
      case "suggest": {
        // The resource's model names the key can read, for "Add model" (typing a name always works).
        const key = await keyFor(r);
        const { models } = await listAzureModels(r, key);
        const have = new Set([...r.deployments.values()].map((d) => d.deployment));
        return { suggestions: models.filter((m) => !have.has(m)) } satisfies CredentialActionResult;
      }
      case "addModel": {
        const d = String(a.deployment ?? "").trim();
        if (!DEPLOYMENT.test(d)) throw new Error("A deployment name has letters, digits, dots, dashes and underscores.");
        if ([...r.deployments.values()].some((x) => x.deployment === d)) throw new Error(`“${d}” is already there.`);
        const t = await tinyCall(r, await keyFor(r), d);
        if (!t.ok) throw new Error(t.message ?? `“${d}” didn't answer (${t.result}).`);
        const m = metaOf(r.stored);
        const deployments = [...(m.deployments ?? []), d];
        if (r.stored) await store.update(r.id, { meta: { ...m, baseUrl: m.baseUrl ?? r.baseUrl, deployments } });
        // The key lives in the shell or the env: a record with no values keeps just the model list.
        else await store.put({ id: r.id, kind: "apiKey", label: r.label, values: {}, endpointHost: r.host, meta: { baseUrl: r.baseUrl, deployments } });
        return { message: t.result === "rate limited" ? t.message : `Added ${d}.` };
      }
      case "removeModel": {
        const d = String(a.deployment ?? "");
        const e = r.deployments.get(d);
        if (!e) throw new Error(`“${d}” isn't there.`);
        if (e.profile) throw new Error(`“${d}” comes from your Codex profile ${e.profile.name}; change it there.`);
        const m = metaOf(r.stored);
        await store.update(r.id, { meta: { ...m, deployments: (m.deployments ?? []).filter((x) => x !== e.deployment) } });
        return { message: `Removed ${d}.` };
      }
      case "storeKey": {
        forgetShell(r.envKey);
        const key = await keyOf(r, true);
        if (!key.value) throw new Error(`There's no key to store: ${r.envKey} isn't set for the runner or in your login shell.`);
        if (key.source !== "tether") await storeKey(r, key.value);
        return { message: "Stored in Tether." };
      }
      case "replaceKey": {
        const apiKey = String(a.apiKey ?? "").trim();
        if (!apiKey) throw new Error("Paste the new key.");
        await checkKey(r, apiKey);
        await storeKey(r, apiKey);
        forgetShell(r.envKey);
        return { message: "Key replaced." };
      }
    }
    throw new Error(`Microsoft Foundry has no “${name}”.`);
  },

  async envFor(id, entry) {
    const r = mustResource(id);
    const key = await keyFor(r);
    // AZURE_TETHER_SESSION_KEY: the pi extension (argsFor) makes this key win over one pi stores itself.
    if (entry.harness === "pi") return { AZURE_OPENAI_API_KEY: key, AZURE_OPENAI_BASE_URL: r.baseUrl, AZURE_TETHER_SESSION_KEY: "1" };
    if (entry.harness === "codex") return { [r.codex ? r.envKey : DEFAULT_ENV_KEY]: key };
    throw new Error(`Microsoft Foundry keys run in Codex and pi, not ${entry.harness}.`);
  },

  // A Codex provider's env_key can be any name (the user's config.toml): declared, so the registry
  // allows it unless it's one no credential may set (PATH, LD_*…). The rest are AZURE_* names.
  envNames(id) {
    const r = resource(id);
    return r?.codex ? [r.envKey] : [];
  },

  argsFor(id, entry) {
    // pi resolves a key in its own auth.json before AZURE_OPENAI_API_KEY: this extension makes the session's pi's runtime key.
    if (entry.harness === "pi") return ["-e", PI_AZURE_EXT];
    if (entry.harness !== "codex") return [];
    return codexArgs(mustResource(id), entry.model);
  },

  async remove(id) {
    const r = resource(id);
    if (!r?.stored) throw new Error(r?.codex ? "This one comes from your Codex config; change it there." : "Nothing stored for it.");
    await store.remove(id);
    forgetShell(r.envKey);
  },
};

/** Tests: whether a startup file names it (shellFile). */
export const _shellFile = shellFile;
