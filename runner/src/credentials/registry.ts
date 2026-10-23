// Credential provider plugins (.claude/credentials/SPEC.md, Stage 0): one plugin per provider
// ("azure", "bedrock", "anthropic"…) owns the credentials whose id starts "<provider>:". It finds
// them (Tether's store, the shell, a CLI's login), tests them, and gives a session's process what
// it needs: env and args from envFor/argsFor, asked once at process start (LiveSession.
// credentialLaunch, every adapter) for the session's "#credential". Only that credential's
// variables go into that process.
//
// Plugins are registered in credentials/index.ts, one line each. A plugin never sends a value to
// the app: views carry labels and last 4 chars at most (store.ts viewOf).

import type { CredentialList, CredentialModel, CredentialProviderInfo, CredentialTest, CredentialView } from "../../../web/src/shared/credentials";
import { credentialProvider } from "../../../web/src/shared/credentials";
import { parseEntry, type ChainEntry, type HarnessId, type ModelRef, type ProviderUsage } from "../../../web/src/shared/protocol";
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
  /** a provider-specific step ("signIn", "addModel", "add"…); `id` is a credential or the bare provider */
  action?(id: string, name: string, args: unknown): Promise<unknown>;
  /** the env a process running `entry` on this credential needs (only this credential's variables) */
  envFor(credId: string, entry: ChainEntry): Promise<Record<string, string>>;
  /** extra command-line args for that process (Codex "-c k=v", pi "--provider"…) */
  argsFor?(credId: string, entry: ChainEntry): string[] | Promise<string[]>;
  /** the models it serves, per harness; absent: the view's own `models` */
  models?(credId: string): Promise<CredentialModel[]>;
  /** its usage now, for fallback's limit check (fallback.ts confirmLimit); absent: can't be checked */
  usage?(credId: string): Promise<ProviderUsage | undefined>;
  /** absent: store.remove (only stored credentials can be removed) */
  remove?(credId: string): Promise<void>;
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

/** Tests: drop one plugin, or all. */
export function unregister(provider?: string) {
  if (provider) plugins.delete(provider);
  else plugins.clear();
  cached = undefined;
}

export const registered = (): CredentialPlugin[] => [...plugins.values()];

/** The plugin that owns a credential id. */
export const pluginFor = (credId: string): CredentialPlugin | undefined => plugins.get(credentialProvider(credId));

const DISCOVER_MS = 20_000;

function timed<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`${what} took too long`)), ms)))]).finally(() => clearTimeout(t));
}

let cached: { at: number; list: CredentialList } | undefined;
const FRESH_MS = 15_000;

/**
 * Every plugin's credentials, grouped by provider in registration order. `order` (the default order)
 * fills each one's `usedIn` ("Default order #2"). A plugin that fails is listed in `errors`.
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
        for (const v of vs) {
          // A plugin lists only its own ids; anything else would route elsewhere.
          if (credentialProvider(v.id) !== p.provider) continue;
          let models = v.models;
          if (p.models) models = await timed(p.models(v.id), DISCOVER_MS, `${p.label} models`).catch(() => v.models);
          credentials.push({ ...v, ...(models?.length ? { models } : {}) });
        }
      } catch (e: any) {
        errors.push({ provider: p.provider, error: e?.message ?? String(e) });
      }
    }),
  );
  const rank = new Map(registered().map((p, i) => [p.provider, i]));
  providers.sort((a, b) => rank.get(a.provider)! - rank.get(b.provider)!);
  credentials.sort((a, b) => rank.get(credentialProvider(a.id))! - rank.get(credentialProvider(b.id))! || a.label.localeCompare(b.label));
  for (const c of credentials) {
    const used = usedIn(c.id, opts.order);
    if (used.length) c.usedIn = [...(c.usedIn ?? []), ...used];
  }
  const list = { providers, credentials, ...(errors.length ? { errors } : {}) };
  cached = { at: Date.now(), list };
  return list;
}

/** "Default order #2" for each default-order entry on this credential. */
export function usedIn(credId: string, order: string[] | undefined): string[] {
  return (order ?? []).flatMap((e, i) => (parseEntry(e, "claude-code").credential === credId ? [`Default order #${i + 1}`] : []));
}

/** A credential's label for notices ("Switched to GPT-6 Luna · Azure"): the last list's, else its id. */
export function credentialLabel(credId: string): string {
  return cached?.list.credentials.find((c) => c.id === credId)?.label ?? store.get(credId)?.label ?? credId;
}

/** The last list, or a fresh one when it's older than a few seconds (model pickers, entry checks). */
async function recent(): Promise<CredentialList> {
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.list;
  return listCredentials();
}

/** The ids this runner has now (entryProblem's check before a default order is saved). */
export async function credentialIds(): Promise<Set<string>> {
  if (!plugins.size) return new Set(store.ids());
  return new Set([...(await recent()).credentials.map((c) => c.id), ...store.ids()]);
}

/**
 * Credential-backed models for one harness's model list: "gpt-6-luna" on "azure:east" reads
 * "GPT-6 Luna · <credentialLabel or the credential's label>".
 */
export async function credentialModels(harness: HarnessId): Promise<ModelRef[]> {
  if (!plugins.size) return [];
  const list = await recent().catch(() => undefined);
  const out: ModelRef[] = [];
  for (const c of list?.credentials ?? [])
    for (const m of c.models ?? [])
      if (m.harness === harness) {
        const { harness: _h, ...ref } = m;
        out.push({ ...ref, credential: c.id, credentialLabel: m.credentialLabel ?? c.label });
      }
  return out;
}

export interface CredentialLaunch {
  /** goes over the runner's env and your secrets, under Tether's own (the guard's key) */
  env: Record<string, string>;
  /** appended to the harness's command line */
  args: string[];
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What a process running `entry` needs from its credential (none without one). Throws when the
 * credential's plugin isn't on this runner: starting on the machine's own login instead would
 * quietly bill another account.
 */
export async function launchFor(entry: ChainEntry): Promise<CredentialLaunch> {
  const id = entry.credential;
  if (!id) return { env: {}, args: [] };
  const p = pluginFor(id);
  if (!p) throw new Error(`${id} isn't available on this runner (nothing handles “${credentialProvider(id) || id}” credentials).`);
  const [env, args] = await Promise.all([p.envFor(id, entry), p.argsFor?.(id, entry) ?? []]);
  for (const [k, v] of Object.entries(env)) if (!ENV_NAME.test(k) || typeof v !== "string") throw new Error(`${p.label}: bad environment variable ${k}`);
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new Error(`${p.label}: bad arguments`);
  return { env: { ...env }, args: [...args] };
}

/** Fresh usage for a credential, when its plugin reads it. */
export async function credentialUsage(credId: string): Promise<ProviderUsage | undefined> {
  return pluginFor(credId)?.usage?.(credId);
}

/** Whether fallback can check this credential's usage (else it never switches on its own). */
export const canCheckUsage = (credId: string) => !!pluginFor(credId)?.usage;

function owner(id: string): CredentialPlugin {
  const p = pluginFor(id) ?? plugins.get(id);
  if (!p) throw new Error(`Nothing on this runner handles ${id}.`);
  return p;
}

export async function testCredential(id: string): Promise<CredentialTest> {
  const p = owner(id);
  if (!p.test) return { ok: false, result: "untested", message: `${p.label} has no test.` };
  return p.test(id);
}

export async function removeCredential(id: string): Promise<void> {
  const p = owner(id);
  if (p.remove) await p.remove(id);
  else if (!(await store.remove(id))) throw new Error("Only keys stored in Tether can be removed here.");
  cached = undefined;
}

/** A provider-specific step; `id` is a credential or a bare provider ("azure" + "add"). */
export async function credentialAction(id: string, action: string, args: unknown): Promise<unknown> {
  const p = owner(id);
  if (!p.action) throw new Error(`${p.label} has no “${action}”.`);
  const r = await p.action(id, action, args);
  cached = undefined;
  return r;
}
