// Tether's own credential store: keys and tokens the user gave Tether (Credentials page), one record
// per credential, in the runner's config dir (credentials.json, mode 600, guard-protected). Plain
// JSON: at-rest encryption isn't a goal (the file is as safe as ~/.codex/auth.json next to it).
//
// Write-only from the app's side: `put` takes values, `get` (runner-only, for a plugin's envFor or
// test) gives them back, `views` is what may leave the runner (no values: last 4 chars at most).
// Plugins own their records (by the "<provider>:" id prefix) and add what they discover elsewhere
// (shell, env, a CLI's login) to their own views.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isCredentialId, type CredentialKind, type CredentialModel, type CredentialView } from "../../../web/src/shared/credentials";
import { Mutex } from "../context/git";
import { configDir } from "../context/paths";
import { writeAtomic } from "../context/store";

export const credentialsFile = () => join(configDir(), "credentials.json");
/** Per-account homes (CLAUDE_CONFIG_DIR, CODEX_HOME, pi's agent dir…) live under here. */
export const accountsDir = () => join(configDir(), "accounts");

/** One stored credential. `values` never leave the runner. */
export interface StoredCredential {
  /** "<provider>:<name>" */
  id: string;
  kind: CredentialKind;
  label: string;
  /** secret values by name ("apiKey", "AWS_SECRET_ACCESS_KEY"…): runner-only */
  values: Record<string, string>;
  /** which value's last 4 characters the app sees (default: the first) */
  last4Of?: string;
  account?: string;
  /** a host, never a URL with credentials in it */
  endpointHost?: string;
  region?: string;
  models?: CredentialModel[];
  /** non-secret settings a plugin keeps with it (endpoint URL, deployment names…): shown to nobody, but not secret */
  meta?: Record<string, unknown>;
  setAt: number;
}

interface Data {
  credentials: Record<string, StoredCredential>;
}

let cache: { mtime: number; data: Data } | undefined;

function load(): Data {
  let mtime = -1;
  try {
    mtime = statSync(credentialsFile()).mtimeMs;
  } catch {}
  if (cache && cache.mtime === mtime && mtime >= 0) return cache.data;
  const data: Data = { credentials: {} };
  try {
    const v = JSON.parse(readFileSync(credentialsFile(), "utf8"));
    for (const [id, c] of Object.entries((v?.credentials ?? {}) as Record<string, any>)) {
      if (!isCredentialId(id) || !c || typeof c !== "object" || !c.values || typeof c.values !== "object") continue;
      const values = Object.fromEntries(Object.entries(c.values).filter((e): e is [string, string] => typeof e[1] === "string"));
      data.credentials[id] = { ...c, id, values, setAt: Number(c.setAt) || 0 };
    }
  } catch {}
  cache = mtime >= 0 ? { mtime, data } : undefined;
  return data;
}

const lock = new Mutex();

function mutate<T>(fn: (d: Data) => T): Promise<T> {
  return lock.run(async () => {
    const d = structuredClone(load());
    const r = fn(d);
    writeAtomic(credentialsFile(), JSON.stringify(d, null, 2) + "\n", 0o600);
    cache = undefined;
    return r;
  });
}

/** For tests: forget the cached file. */
export function resetCredentialStore() {
  cache = undefined;
}

/** Stores (or replaces) one credential. `setAt` is now. */
export async function put(c: Omit<StoredCredential, "setAt">): Promise<void> {
  if (!isCredentialId(c.id)) throw new Error(`“${c.id}” isn't a credential id ("provider:name").`);
  for (const [k, v] of Object.entries(c.values)) {
    if (typeof v !== "string") throw new Error(`${k} must be text.`);
    if (v.includes("\0")) throw new Error(`${k} can't contain a NUL character.`);
  }
  await mutate((d) => {
    d.credentials[c.id] = { ...structuredClone(c), setAt: Date.now() };
  });
}

/** Runner-only: the stored record, values and all (a plugin's envFor / test). */
export function get(id: string): StoredCredential | undefined {
  const c = load().credentials[id];
  return c && structuredClone(c);
}

/** Changes a stored record's non-secret fields (models, meta, label…); values only through `put`. */
export async function update(id: string, change: Partial<Omit<StoredCredential, "id" | "values" | "setAt">>): Promise<boolean> {
  return mutate((d) => {
    const c = d.credentials[id];
    if (!c) return false;
    d.credentials[id] = { ...c, ...structuredClone(change), id, values: c.values, setAt: c.setAt };
    return true;
  });
}

export async function remove(id: string): Promise<boolean> {
  return mutate((d) => {
    const had = id in d.credentials;
    delete d.credentials[id];
    return had;
  });
}

/** Runner-only: every stored value (the registry masks them in messages it passes on). */
export function allValues(): string[] {
  return Object.values(load().credentials).flatMap((c) => Object.values(c.values));
}

/** Stored ids, of one provider ("azure") or all. */
export function ids(provider?: string): string[] {
  return Object.keys(load().credentials)
    .filter((id) => !provider || id.startsWith(provider + ":"))
    .sort();
}

const last4 = (v: string | undefined) => (v && v.length >= 8 ? v.slice(-4) : undefined);

/** What may leave the runner about one stored credential. */
export function viewOf(c: StoredCredential, provider = c.id.slice(0, c.id.indexOf(":"))): CredentialView {
  const shown = c.last4Of ? c.values[c.last4Of] : Object.values(c.values)[0];
  return {
    id: c.id,
    kind: c.kind,
    provider,
    label: c.label,
    ...(c.account ? { account: c.account } : {}),
    ...(c.endpointHost ? { endpointHost: c.endpointHost } : {}),
    ...(c.region ? { region: c.region } : {}),
    ...(last4(shown) ? { last4: last4(shown) } : {}),
    source: "tether",
    state: Object.values(c.values).some(Boolean) ? "ok" : "missing",
    setAt: c.setAt,
    ...(c.models?.length ? { models: c.models } : {}),
  };
}

/** Redacted views of the stored credentials, of one provider or all. */
export function views(provider?: string): CredentialView[] {
  const d = load();
  return ids(provider).map((id) => viewOf(d.credentials[id]!));
}
