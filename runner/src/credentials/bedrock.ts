// AWS Bedrock (.claude/credentials/SPEC.md section 6): Claude Code (native Bedrock) and pi
// (`amazon-bedrock` provider) on one of three kinds of AWS credential:
//  - a Bedrock API key (AWS_BEARER_TOKEN_BEDROCK), stored in Tether ("bedrock:<name>");
//  - an access key id + secret (+ session token), stored in Tether ("bedrock:<name>");
//  - an AWS CLI profile from ~/.aws, found on its own ("bedrock:aws.<profile>"). Tether never reads
//    or copies its secrets: processes get AWS_PROFILE and the AWS SDK in each harness reads the
//    profile itself (both support `aws login` sessions). Its state comes from the AWS CLI.
// "Key once, models any time": a credential's models are Bedrock model ids / inference profiles
// ("us.anthropic.claude-opus-5-5") the user added (listed from the region where the credential
// may, else typed), each tested with one tiny Converse call. Each reads "Opus 5.5 · Bedrock" in
// Claude Code (Anthropic models) and pi ("amazon-bedrock/<id>").
// No usage feed: fallback leaves Bedrock entries to the fault text (fallback.ts bedrockFault).

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { CredentialActionResult, CredentialModel, CredentialState, CredentialTest, CredentialView } from "../../../web/src/shared/credentials";
import type { ChainEntry } from "../../../web/src/shared/protocol";
import type { CredentialPlugin } from "./registry";
import * as store from "./store";

/** Every AWS variable a credential could set: the ones a credential doesn't set are blanked, so only its own reach the process. */
export const AWS_SECRET_VARS = ["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"] as const;

/**
 * Pass-through variables that could send a Bedrock process's auth or calls elsewhere (another
 * config file, a role, a container's credentials, another endpoint): blanked too. Profiles read
 * the default ~/.aws files. Every AWS_ENDPOINT_URL_* / AWS_CONTAINER_CREDENTIALS_* in the runner's
 * env is added (blankedVars).
 */
export const AWS_REDIRECT_VARS = [
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_BEDROCK",
  "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
  "AWS_ENDPOINT_URL_STS",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
] as const;

/** Every variable blanked for a Bedrock process (or an `aws` call) unless its credential sets it. */
export function blankedVars(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = Object.keys(env).filter((k) => k.startsWith("AWS_ENDPOINT_URL") || k.startsWith("AWS_CONTAINER_CREDENTIALS_"));
  return [...new Set([...AWS_SECRET_VARS, ...AWS_REDIRECT_VARS, ...extra])];
}

export const REGION = /^[a-z]{2}(-gov|-iso[a-z]*)?-[a-z]+-\d{1,2}$/;
/** A Bedrock model id, inference profile id or ARN; no "#" (chain entries) or spaces. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,199}$/;
const PROFILE = /^[A-Za-z0-9._@+-]{1,80}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,47}$/;
const PROFILE_PREFIX = "aws.";
const MAX_PROFILES = 10;

export type Kind = "apiKey" | "awsKeys" | "awsProfile";

// ---- the AWS CLI and the Bedrock REST API (swappable in tests) ----

export interface CliResult {
  ok: boolean;
  out: string;
  err: string;
}

function awsBin() {
  return process.env.TETHER_AWS_CLI || (existsSync("/usr/local/bin/aws") ? "/usr/local/bin/aws" : "aws");
}

/** The runner's env without any AWS credential variable, plus `env`: what an `aws` call for one credential runs with. */
export function cliEnv(env: Record<string, string>): Record<string, string> {
  const blank = new Set(blankedVars());
  const base = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !blank.has(e[0])));
  return { ...base, AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off", ...env };
}

let cli = (args: string[], env: Record<string, string>, timeoutMs = 20_000): Promise<CliResult> =>
  new Promise((resolve) => {
    const child = execFile(awsBin(), args, { env: cliEnv(env), timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 << 20 }, (e, out, err) =>
      resolve({ ok: !e, out: String(out ?? ""), err: String(err ?? "") || (e && !err ? e.message : "") }),
    );
    // Nothing to type: an MFA or SSO prompt gets end-of-input and fails rather than waiting.
    child.stdin?.on("error", () => {});
    child.stdin?.end();
  });

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let http: Fetch = (url, init) => fetch(url, init);

/** Tests: replace the AWS CLI and fetch. */
export function setBedrockIo(io: { cli?: typeof cli; fetch?: Fetch }) {
  if (io.cli) cli = io.cli;
  if (io.fetch) http = io.fetch;
  profileCache.clear();
  forgetProfiles();
}

// ---- credentials ----

/** Everything needed to call Bedrock as one credential. Runner-only (values inside). */
interface Resolved {
  id: string;
  kind: Kind;
  name: string;
  region: string;
  /** the credential's own AWS variables */
  env: Record<string, string>;
  /** API key only: used as a bearer token on the REST API */
  bearer?: string;
  models: string[];
}

const profileOf = (id: string) => (id.startsWith(`bedrock:${PROFILE_PREFIX}`) ? id.slice(`bedrock:${PROFILE_PREFIX}`.length) : undefined);
const nameOf = (id: string) => id.slice("bedrock:".length);

/** The model ids added to a credential (kept on its store record; for a profile, a record without values). */
function storedModels(id: string): string[] {
  const m = store.get(id)?.meta?.models;
  return Array.isArray(m) ? m.filter((x): x is string => typeof x === "string") : [];
}

async function profileRegion(profile: string): Promise<string | undefined> {
  const r = await cli(["configure", "get", "region", "--profile", profile], {});
  const v = r.out.trim();
  return r.ok && REGION.test(v) ? v : undefined;
}

async function resolve(id: string): Promise<Resolved> {
  const profile = profileOf(id);
  if (profile) {
    const rec = store.get(id);
    const region = (rec?.region as string | undefined) ?? (await profileRegion(profile)) ?? "us-east-1";
    return { id, kind: "awsProfile", name: profile, region, env: { AWS_PROFILE: profile }, models: storedModels(id) };
  }
  const rec = store.get(id);
  if (!rec) throw new Error(`${id} isn't stored on this runner.`);
  const region = rec.region ?? "us-east-1";
  const v = rec.values;
  if (rec.kind === "apiKey") {
    if (!v.AWS_BEARER_TOKEN_BEDROCK) throw new Error(`${id} has no API key stored.`);
    return { id, kind: "apiKey", name: nameOf(id), region, env: { AWS_BEARER_TOKEN_BEDROCK: v.AWS_BEARER_TOKEN_BEDROCK }, bearer: v.AWS_BEARER_TOKEN_BEDROCK, models: storedModels(id) };
  }
  if (!v.AWS_ACCESS_KEY_ID || !v.AWS_SECRET_ACCESS_KEY) throw new Error(`${id} has no access key stored.`);
  const env: Record<string, string> = { AWS_ACCESS_KEY_ID: v.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: v.AWS_SECRET_ACCESS_KEY };
  if (v.AWS_SESSION_TOKEN) env.AWS_SESSION_TOKEN = v.AWS_SESSION_TOKEN;
  return { id, kind: "awsKeys", name: nameOf(id), region, env, models: storedModels(id) };
}

/** The AWS variables a process on this credential gets: its own, the region, the others blanked. */
export function awsEnv(r: Pick<Resolved, "env" | "region">): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of blankedVars()) out[k] = "";
  return { ...out, ...r.env, AWS_REGION: r.region, AWS_DEFAULT_REGION: r.region };
}

// ---- models ----

/** Anthropic models run in Claude Code too; everything runs in pi. */
export const isAnthropic = (model: string) => /(^|[.:/])anthropic\./i.test(model);

export function modelsOf(ids: string[], credentialLabel: string): CredentialModel[] {
  const out: CredentialModel[] = [];
  for (const id of ids) {
    if (isAnthropic(id)) out.push({ harness: "claude-code", id, credentialLabel });
    out.push({ harness: "pi", id: `amazon-bedrock/${id}`, credentialLabel });
  }
  return out;
}

/** The Bedrock id an entry runs: pi's "amazon-bedrock/<id>" or Claude Code's bare id. */
export const bedrockModel = (entry: Pick<ChainEntry, "model">) => entry.model.replace(/^amazon-bedrock\//, "");

export interface ModelChoice {
  id: string;
  name: string;
  /** "Inference profile" / "Model" */
  kind: string;
}

/** Inference profiles first (Anthropic's first among them), then on-demand foundation models. */
export function modelChoices(profiles: any[], models: any[]): ModelChoice[] {
  const out: ModelChoice[] = [];
  const seen = new Set<string>();
  const add = (id: unknown, name: unknown, kind: string) => {
    if (typeof id !== "string" || !MODEL_ID.test(id) || seen.has(id)) return;
    seen.add(id);
    out.push({ id, name: typeof name === "string" && name ? name : id, kind });
  };
  const anthropicFirst = (a: string, b: string) => Number(!isAnthropic(a)) - Number(!isAnthropic(b)) || a.localeCompare(b);
  for (const p of [...profiles].filter((p) => !p?.status || p.status === "ACTIVE").sort((a, b) => anthropicFirst(String(a?.inferenceProfileId), String(b?.inferenceProfileId))))
    add(p.inferenceProfileId, p.inferenceProfileName, "Inference profile");
  for (const m of [...models].filter((m) => (m?.inferenceTypesSupported ?? []).includes("ON_DEMAND") && (m?.modelLifecycle?.status ?? "ACTIVE") === "ACTIVE").sort((a, b) => anthropicFirst(String(a?.modelId), String(b?.modelId))))
    add(m.modelId, [m.providerName, m.modelName].filter(Boolean).join(" "), "Model");
  return out;
}

const found = (models: ModelChoice[], region: string) => ({ models, message: `${models.length} models in ${region}.` });

/** The region's models and inference profiles, when the credential may list them. */
async function listModels(r: Resolved): Promise<{ models: ModelChoice[]; message: string } | { error: string; reason: string }> {
  try {
    if (r.bearer) {
      const get = async (path: string) => {
        const res = await http(`https://bedrock.${r.region}.amazonaws.com${path}`, { headers: { authorization: `Bearer ${r.bearer}`, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
        const body: any = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(awsError(res.headers.get("x-amzn-errortype"), body?.message ?? body?.Message, res.status));
        return body;
      };
      const [p, m] = await Promise.all([get("/inference-profiles?maxResults=1000"), get("/foundation-models?byOutputModality=TEXT")]);
      return found(modelChoices(p.inferenceProfileSummaries ?? [], m.modelSummaries ?? []), r.region);
    }
    const [p, m] = await Promise.all([
      cli(["bedrock", "list-inference-profiles", "--region", r.region, "--max-results", "1000", "--output", "json"], r.env),
      cli(["bedrock", "list-foundation-models", "--region", r.region, "--by-output-modality", "TEXT", "--output", "json"], r.env),
    ]);
    if (!p.ok) throw new Error(cliError(p.err));
    if (!m.ok) throw new Error(cliError(m.err));
    return found(modelChoices(JSON.parse(p.out).inferenceProfileSummaries ?? [], JSON.parse(m.out).modelSummaries ?? []), r.region);
  } catch (e: any) {
    const reason = String(e?.message ?? e);
    return { error: `Couldn't list this region's models (${reason}). Type a model id instead.`, reason };
  }
}

// ---- errors and the tiny call ----

/** "AccessDeniedException: …" from an x-amzn-errortype header ("AccessDeniedException:http://…") and a message. */
function awsError(type: string | null | undefined, message: unknown, status?: number): string {
  const t = (type ?? "").split(":")[0];
  const m = typeof message === "string" ? message : "";
  return [t, m].filter(Boolean).join(": ") || `HTTP ${status ?? "error"}`;
}

/** The AWS CLI's error line ("An error occurred (X) when calling …: msg" / "aws: [ERROR]: …"), never more. */
export function cliError(err: string): string {
  const lines = err.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /error/i.test(l)) ?? lines[0] ?? "the AWS CLI failed";
  const m = line.match(/An error occurred \((\w+)\)[^:]*:\s*(.*)/);
  return (m ? `${m[1]}: ${m[2]}` : line.replace(/^aws: \[ERROR\]:\s*/, "")).slice(0, 300);
}

/** What a failed call means, for Test. */
export function testResult(message: string): CredentialTest {
  const m = message;
  const say = (result: string, text: string): CredentialTest => ({ ok: false, result, message: text });
  if (/session has expired|reauthenticate|ExpiredToken|token has expired|expired/i.test(m)) return say("expired", `Signed out: ${m}`);
  if (/UnrecognizedClient|InvalidSignature|SignatureDoesNotMatch|security token included in the request is invalid|invalid api key|Invalid bearer|could not be found|Unable to locate credentials|UnauthorizedException/i.test(m)) return say("invalid", `Not accepted: ${m}`);
  if (/ServiceQuotaExceeded|service quota|per day/i.test(m)) return say("quota", `Over a quota: ${m}`);
  if (/Throttling|Too many (requests|tokens)|Rate exceeded/i.test(m)) return { ok: true, result: "rate limited", message: `Works, but rate limited right now: ${m}` };
  if (/AccessDenied|don't have access|not authorized|explicit deny/i.test(m)) return say("no access", `No access to this model: ${m}`);
  if (/ValidationException|ResourceNotFound|model identifier is invalid|isn't supported|not supported|on-demand throughput/i.test(m)) return say("wrong model", `Not a model this region runs that way: ${m}`);
  return say("error", m);
}

/** One Converse call with maxTokens 1. */
async function tinyCall(r: Resolved, model: string): Promise<CredentialTest> {
  const messages = [{ role: "user", content: [{ text: "Reply with OK." }] }];
  try {
    if (r.bearer) {
      const res = await http(`https://bedrock-runtime.${r.region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`, {
        method: "POST",
        headers: { authorization: `Bearer ${r.bearer}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ messages, inferenceConfig: { maxTokens: 1 } }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return { ok: true, result: "valid", message: `Works: ${model} answered in ${r.region}.` };
      const body: any = await res.json().catch(() => ({}));
      return testResult(awsError(res.headers.get("x-amzn-errortype"), body?.message ?? body?.Message, res.status));
    }
    const out = await cli(["bedrock-runtime", "converse", "--region", r.region, "--model-id", model, "--messages", JSON.stringify(messages), "--inference-config", JSON.stringify({ maxTokens: 1 }), "--output", "json"], r.env, 40_000);
    if (out.ok) return { ok: true, result: "valid", message: `Works: ${model} answered in ${r.region}.` };
    return testResult(cliError(out.err));
  } catch (e: any) {
    return { ok: false, result: "error", message: e?.message ?? String(e) };
  }
}

// ---- AWS profiles (~/.aws, through the AWS CLI) ----

interface ProfileStatus {
  region?: string;
  /** the `aws login` identity (arn), when it is a console login */
  login?: string;
  state: CredentialState;
  note?: string;
  expiresAt?: number;
}

const profileCache = new Map<string, { at: number; s: ProfileStatus }>();
/** How long a profile's status holds: a check runs the AWS CLI a few times, so not on every list. */
const PROFILE_FRESH_MS = 5 * 60_000;
/** Profile settings that mean getting credentials may run a program, prompt, or call SSO/STS. */
const ACTIVE_SETTINGS = ["credential_process", "sso_session", "sso_start_url", "mfa_serial", "role_arn"];

async function profileStatus(profile: string): Promise<ProfileStatus> {
  const hit = profileCache.get(profile);
  if (hit && Date.now() - hit.at < PROFILE_FRESH_MS) return hit.s;
  const setting = (k: string) => cli(["configure", "get", k, "--profile", profile], {}, 10_000);
  const [region, login, ...active] = await Promise.all([profileRegion(profile), setting("login_session"), ...ACTIVE_SETTINGS.map(setting)]);
  const s: ProfileStatus = { region, ...(login.ok && login.out.trim().startsWith("arn:") ? { login: login.out.trim() } : {}), state: "unknown" };
  const kind = ACTIVE_SETTINGS.find((_, i) => active[i]!.ok && active[i]!.out.trim());
  if (kind) {
    // SSO, MFA, a role or a credential_process: a background check could prompt, open a browser or
    // run a program every few minutes. Test makes the one real call instead.
    s.note = `Not checked in the background (the profile uses ${kind}): Test checks it.`;
    profileCache.set(profile, { at: Date.now(), s });
    return s;
  }
  // An `aws login` or a static-key profile: reading its credentials only reads ~/.aws (and renews a
  // login). Only the expiry is kept; the values are dropped here and never leave this function.
  const creds = await cli(["configure", "export-credentials", "--profile", profile, "--format", "process"], {}, 10_000);
  if (creds.ok) {
    let exp: number | undefined;
    try {
      exp = Date.parse(JSON.parse(creds.out)?.Expiration ?? "") || undefined;
    } catch {}
    s.state = "ok";
    s.expiresAt = exp;
  } else {
    const e = cliError(creds.err);
    s.state = /expired|reauthenticate/i.test(e) ? "expired" : /could not be found|Unable to locate|not configured|partial credentials/i.test(e) ? "missing" : "unknown";
    s.note = s.state === "expired" ? (s.login ? "The aws login session has expired: sign in again." : `Expired: ${e}`) : e;
  }
  profileCache.set(profile, { at: Date.now(), s });
  return s;
}

/** "123456789012 (root)" from "arn:aws:iam::123456789012:root"; "123456789012 (alice)" for a user/role. */
export function accountOf(arn: string | undefined): string | undefined {
  const m = arn?.match(/^arn:aws[\w-]*:(?:iam|sts)::(\d{12}):(.+)$/);
  if (!m) return undefined;
  const who = m[2] === "root" ? "root" : m[2]!.split("/").pop();
  return `${m[1]} (${who})`;
}

const inMinutes = (t: number) => {
  const m = Math.round((t - Date.now()) / 60_000);
  return m < 1 ? "in under a minute" : m < 120 ? `in ${m} min` : `in ${Math.round(m / 60)} h`;
};

async function profileView(profile: string): Promise<CredentialView> {
  const id = `bedrock:${PROFILE_PREFIX}${profile}`;
  const s = await profileStatus(profile);
  const rec = store.get(id);
  const region = rec?.region ?? s.region ?? "us-east-1";
  const root = s.login?.endsWith(":root");
  const notes = [
    s.note,
    s.state === "ok" && s.expiresAt ? `${s.login ? "Signed in with aws login; current credentials renew" : "Credentials expire"} ${inMinutes(s.expiresAt)}.` : undefined,
    root ? "This is the account's root user: an IAM user or a Bedrock API key is safer." : undefined,
    !s.region && !rec?.region ? "No region in the profile: us-east-1 is used." : undefined,
  ].filter(Boolean);
  return {
    id,
    kind: "awsProfile",
    provider: "bedrock",
    label: `AWS Bedrock · ${profile} · ${region}`,
    ...(accountOf(s.login) ? { account: accountOf(s.login) } : {}),
    region,
    source: "cli",
    sourceNote: `AWS profile “${profile}” in ~/.aws`,
    state: s.state,
    ...(notes.length ? { stateNote: notes.join(" ") } : {}),
    actions: ["addModel", "removeModel", "listModels", "setRegion", ...(s.login ? ["signIn"] : [])],
  };
}

/** `aws configure list-profiles`, kept 5 minutes (every list and action asks); an action or Test asks again. */
let profileList: { at: number; names: Promise<string[]> } | undefined;

function profiles(): Promise<string[]> {
  if (profileList && Date.now() - profileList.at < PROFILE_FRESH_MS) return profileList.names;
  const names = cli(["configure", "list-profiles"], {}).then((r) =>
    r.ok
      ? r.out
          .split("\n")
          .map((l) => l.trim())
          .filter((p) => PROFILE.test(p))
          .slice(0, MAX_PROFILES)
      : [],
  );
  const entry = { at: Date.now(), names };
  profileList = entry;
  // A failed call isn't kept.
  names.then((n) => !n.length && profileList === entry && (profileList = undefined)).catch(() => (profileList = undefined));
  return names;
}

/** The profiles are read again on the next ask (an action, Test, tests swapping the CLI). */
const forgetProfiles = () => (profileList = undefined);

/** A "bedrock:aws.<profile>" id must name a profile the AWS CLI lists (not any name a caller sends). */
async function knownProfile(id: string) {
  const p = profileOf(id);
  if (p !== undefined && !(await profiles()).includes(p)) throw new Error(`There's no AWS profile “${p}” on this runner.`);
}

export const isHaiku = (model: string) => isAnthropic(model) && /claude-haiku/i.test(model);

/** Claude Code's background model on this credential: a Haiku it has added, else the region's listed one. */
function haikuOf(r: Resolved): string | undefined {
  const own = r.models.find(isHaiku);
  if (own) return own;
  const listed = store.get(r.id)?.meta?.haiku;
  return typeof listed === "string" && MODEL_ID.test(listed) ? listed : undefined;
}

// ---- "Sign in again": relays `aws login --remote` ----

const logins = new Map<string, { proc: ChildProcess; output: string; timer: ReturnType<typeof setTimeout> }>();
const SIGNIN_URL = /https:\/\/[\w.-]*signin\.aws(?:\.amazon)?\.com\/\S+/;

function endLogin(id: string) {
  const l = logins.get(id);
  if (!l) return;
  clearTimeout(l.timer);
  l.proc.kill();
  logins.delete(id);
}

/** Starts `aws login --remote` for a profile and gives back the URL to open; the code goes to signInCode. */
async function startLogin(id: string, profile: string): Promise<{ url: string }> {
  endLogin(id);
  const proc = spawn(awsBin(), ["login", "--remote", "--profile", profile], { env: cliEnv({}), stdio: ["pipe", "pipe", "pipe"] });
  // The CLI may be gone when the code is written (EPIPE): never an uncaught error in the runner.
  proc.stdin!.on("error", () => {});
  const l = { proc, output: "", timer: setTimeout(() => endLogin(id), 10 * 60_000) };
  logins.set(id, l);
  return new Promise((resolve, reject) => {
    const give = setTimeout(() => (endLogin(id), reject(new Error("aws login didn't give a sign-in URL."))), 20_000);
    const on = (d: Buffer) => {
      l.output += d.toString();
      const url = l.output.match(SIGNIN_URL)?.[0];
      if (url) {
        clearTimeout(give);
        resolve({ url });
      }
    };
    proc.stdout!.on("data", on);
    proc.stderr!.on("data", on);
    proc.on("error", (e) => (clearTimeout(give), endLogin(id), reject(e)));
    proc.on("exit", () => {
      clearTimeout(give);
      if (logins.get(id) === l) logins.delete(id);
      reject(new Error(cliError(l.output) || "aws login ended."));
    });
  });
}

/** Hands the browser's authorization code to the waiting `aws login`. */
async function finishLogin(id: string, code: string): Promise<{ message: string }> {
  const l = logins.get(id);
  if (!l) throw new Error("No sign-in is waiting: start it again.");
  if (!/^[\w.~+/=-]{4,4096}$/.test(code)) throw new Error("That doesn't look like an authorization code.");
  const done = new Promise<number | null>((resolve) => l.proc.once("exit", resolve));
  l.proc.stdin!.write(code + "\n");
  let slow: ReturnType<typeof setTimeout> | undefined;
  const exit = await Promise.race([done, new Promise<"slow">((r) => (slow = setTimeout(() => r("slow"), 60_000)))]).finally(() => clearTimeout(slow));
  const output = l.output;
  endLogin(id);
  profileCache.delete(profileOf(id)!);
  if (exit !== 0) throw new Error(exit === "slow" ? "aws login didn't finish." : cliError(output));
  return { message: "Signed in again." };
}

// ---- the plugin ----

export const bedrockPlugin: CredentialPlugin = {
  provider: "bedrock",
  label: "AWS Bedrock",
  actions: ["add"],

  async discover() {
    const stored = store.views("bedrock").filter((v) => !profileOf(v.id));
    const discovered = await Promise.all((await profiles()).map((p) => profileView(p).catch(() => undefined)));
    const views = [...stored.map((v) => ({ ...v, label: `AWS Bedrock · ${v.label} · ${v.region ?? "us-east-1"}`, actions: ["addModel", "removeModel", "listModels"] })), ...discovered.filter((v): v is CredentialView => !!v)];
    // "Opus 5.5 · Bedrock" while one credential serves models; with more, each says which.
    const serving = views.filter((v) => storedModels(v.id).length);
    for (const v of views) {
      const short = serving.length > 1 ? `Bedrock ${profileOf(v.id) ?? nameOf(v.id)}` : "Bedrock";
      const ids = storedModels(v.id);
      if (ids.length) v.models = modelsOf(ids, short);
    }
    return views;
  },

  async test(id) {
    forgetProfiles();
    await knownProfile(id);
    const r = await resolve(id);
    if (r.models[0]) return tinyCall(r, r.models[0]);
    // No model yet: listing the region's models shows whether the credential works at all.
    const l = await listModels(r);
    return "error" in l ? testResult(l.reason) : { ok: true, result: "valid", message: `Works: ${l.models.length} models in ${r.region}. Add one to use it.` };
  },

  async action(id, name, args) {
    forgetProfiles();
    const a = (args ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : "");
    if (id === "bedrock" && name === "add") {
      const kind = str("kind");
      const slug = str("name");
      const region = str("region") || "us-east-1";
      if (!NAME.test(slug) || slug.startsWith(PROFILE_PREFIX)) throw new Error("Give it a short name (letters, digits, . _ - @ +).");
      if (!REGION.test(region)) throw new Error(`“${region}” isn't an AWS region.`);
      // A key added again under the same name replaces the key, not the models added to it.
      const kept = store.get(`bedrock:${slug}`)?.meta;
      const meta = kept ? { meta: kept } : {};
      if (kind === "apiKey") {
        const key = str("apiKey");
        if (key.length < 20 || /\s/.test(key)) throw new Error("Paste the whole Bedrock API key.");
        await store.put({ id: `bedrock:${slug}`, kind: "apiKey", label: slug, region, values: { AWS_BEARER_TOKEN_BEDROCK: key }, last4Of: "AWS_BEARER_TOKEN_BEDROCK", ...meta });
      } else if (kind === "awsKeys") {
        const keyId = str("accessKeyId");
        const secret = str("secretAccessKey");
        const token = str("sessionToken");
        if (!/^[A-Z0-9]{16,128}$/.test(keyId)) throw new Error("That isn't an access key id (AKIA…).");
        if (secret.length < 20 || /\s/.test(secret)) throw new Error("Paste the whole secret access key.");
        await store.put({
          id: `bedrock:${slug}`,
          kind: "awsKeys",
          label: slug,
          region,
          account: keyId.slice(0, 4) + "…" + keyId.slice(-4),
          values: { AWS_ACCESS_KEY_ID: keyId, AWS_SECRET_ACCESS_KEY: secret, ...(token ? { AWS_SESSION_TOKEN: token } : {}) },
          last4Of: "AWS_SECRET_ACCESS_KEY",
          ...meta,
        });
      } else throw new Error("Pick a Bedrock API key or an access key.");
      return { id: `bedrock:${slug}` };
    }
    await knownProfile(id);
    const r = await resolve(id);
    if (name === "listModels") {
      const l = await listModels(r);
      // Can't list: the page says why and takes a typed id.
      if ("error" in l) return { message: l.error } satisfies CredentialActionResult;
      // The region's Haiku inference profile, for Claude Code's background model (envFor).
      const haiku = l.models.find((m) => m.kind === "Inference profile" && isHaiku(m.id))?.id;
      if (haiku && haiku !== store.get(id)?.meta?.haiku) await keepMeta(id, r, { haiku });
      return { message: l.message, models: l.models.map((m) => ({ id: m.id, label: `${m.name} · ${m.kind}` })) } satisfies CredentialActionResult;
    }
    if (name === "addModel") {
      const model = str("model").replace(/^amazon-bedrock\//, "");
      if (!MODEL_ID.test(model)) throw new Error(`“${model}” isn't a Bedrock model id.`);
      const test = await tinyCall(r, model);
      if (!test.ok) throw new Error(test.message ?? `Didn't work: ${test.result}.`);
      await keepModels(id, r, [...r.models.filter((m) => m !== model), model]);
      return { message: test.message };
    }
    if (name === "removeModel") {
      await keepModels(id, r, r.models.filter((m) => m !== str("model")));
      return { message: "Removed." };
    }
    const profile = profileOf(id);
    if (profile && name === "setRegion") {
      const region = str("region");
      if (region && !REGION.test(region)) throw new Error(`“${region}” isn't an AWS region.`);
      await keepProfile(id, { region: region || undefined });
      return { message: `Region: ${region || "the profile's own"}.` };
    }
    if (profile && name === "signIn") {
      const { url } = await startLogin(id, profile);
      return {
        url,
        message: "Open the AWS sign-in page, sign in, and paste the authorization code it shows. This runs aws login on the runner and updates its profile.",
        next: { action: "signInCode", prompt: "Paste the authorization code", field: "code", secret: true },
      } satisfies CredentialActionResult;
    }
    if (profile && name === "signInCode") return finishLogin(id, str("code"));
    throw new Error(`AWS Bedrock has no “${name}”.`);
  },

  async envFor(id, entry) {
    const r = await resolve(id);
    const env = awsEnv(r);
    if (entry.harness === "claude-code") {
      // Claude Code talks to Bedrock instead of Anthropic only when told to.
      env.CLAUDE_CODE_USE_BEDROCK = "1";
      // Its background model (titles, quick checks): a Haiku this credential has, else Claude
      // Code's own Bedrock default.
      const haiku = haikuOf(r);
      if (haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = env.ANTHROPIC_SMALL_FAST_MODEL = haiku;
    }
    return env;
  },

  async remove(id) {
    // A profile's row is ~/.aws's: only Tether's own record (its models, region) goes.
    if (!(await store.remove(id)) && !profileOf(id)) throw new Error("Only keys stored in Tether can be removed here.");
    if (profileOf(id)) profileCache.delete(profileOf(id)!);
  },
};

/** Stores a credential's model list: on its own record, or a values-less one for a profile. */
async function keepModels(id: string, r: Resolved, models: string[]) {
  return keepMeta(id, r, { models });
}

/** Changes a credential's non-secret settings (models, haiku). */
async function keepMeta(id: string, r: Resolved, patch: Record<string, unknown>) {
  if (r.kind === "awsProfile") return keepProfile(id, { meta: patch });
  await store.update(id, { meta: { ...(store.get(id)?.meta ?? {}), ...patch } });
}

async function keepProfile(id: string, change: { meta?: Record<string, unknown>; region?: string }) {
  const rec = store.get(id);
  const meta = { ...(rec?.meta ?? {}), ...(change.meta ?? {}) };
  const region = "region" in change ? change.region : rec?.region;
  if (!rec) {
    await store.put({ id, kind: "awsProfile", label: profileOf(id)!, values: {}, meta, ...(region ? { region } : {}) });
    return;
  }
  await store.update(id, { meta, region });
}
