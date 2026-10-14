// Tether's env and secrets (docs/harness-platform.md, Phase 2 "later slots"): name → value pairs
// kept in the runner's config dir (secrets.json, mode 600) and edited in Settings. Every agent
// process gets them in its environment, and so does every MCP registry server Tether launches a
// session with: a registry entry may also use them as `${NAME}` (or `${NAME:-default}`) in its env
// values and headers. References are resolved only at launch, into what goes to the harness over
// its launch API; the registry, the global MCP export and the logs keep the `${NAME}` text.
//
// Values never leave the runner: the web app sees names and when they were set.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { McpTransport, SecretView } from "../../web/src/shared/protocol";
import { Mutex } from "./context/git";
import { configDir } from "./context/paths";
import { writeAtomic } from "./context/store";

export const secretsFile = () => join(configDir(), "secrets.json");

interface StoredSecret {
  value: string;
  updatedAt: number;
}

interface SecretsData {
  secrets: Record<string, StoredSecret>;
}

/** An environment variable name. */
export const isSecretName = (n: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && n.length <= 128;

/**
 * Names Tether or the process itself depends on: a secret can't replace them (the guard's key, the
 * relay's credentials, where the harnesses find their config and binaries).
 */
const RESERVED = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "TMPDIR", "LANG", "TERM", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"]);
export const isReservedName = (n: string) => RESERVED.has(n.toUpperCase()) || /^TETHER_/i.test(n) || /^CLAUDE_CODE_/i.test(n);

let cache: { mtime: number; data: SecretsData } | undefined;

function load(): SecretsData {
  let mtime = -1;
  try {
    mtime = statSync(secretsFile()).mtimeMs;
  } catch {}
  if (cache && cache.mtime === mtime && mtime >= 0) return cache.data;
  let data: SecretsData = { secrets: {} };
  try {
    const v = JSON.parse(readFileSync(secretsFile(), "utf8"));
    if (v && v.secrets && typeof v.secrets === "object") {
      for (const [k, s] of Object.entries(v.secrets as Record<string, any>))
        if (isSecretName(k) && typeof s?.value === "string") data.secrets[k] = { value: s.value, updatedAt: Number(s.updatedAt) || 0 };
    }
  } catch {}
  cache = mtime >= 0 ? { mtime, data } : undefined;
  return data;
}

const lock = new Mutex();

function mutate<T>(fn: (d: SecretsData) => T): Promise<T> {
  return lock.run(async () => {
    const d = structuredClone(load());
    const r = fn(d);
    writeAtomic(secretsFile(), JSON.stringify(d, null, 2) + "\n", 0o600);
    cache = undefined;
    return r;
  });
}

/** For tests: forget the cached file. */
export function resetSecretsCache() {
  cache = undefined;
}

/** name → value, for an agent process's environment. */
export function secretEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, s] of Object.entries(load().secrets)) if (!isReservedName(k)) out[k] = s.value;
  return out;
}

/**
 * The environment for a harness process: the runner's own, then your secrets, then what Tether
 * itself sets (the guard's key and friends), which a secret never overrides.
 */
export function agentEnv(own: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...process.env, ...secretEnv(), ...own };
}

export function listSecrets(): SecretView[] {
  return Object.entries(load().secrets)
    .map(([name, s]) => ({ name, updatedAt: s.updatedAt }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Sets (or, with `remove`, deletes) one secret. A value is never sent back. */
export async function setSecret(name: string, change: { value?: string; remove?: boolean }): Promise<SecretView[]> {
  const n = name.trim();
  if (change.remove) {
    await mutate((d) => {
      delete d.secrets[n];
    });
    return listSecrets();
  }
  if (!isSecretName(n)) throw new Error("A name has letters, digits and underscores, and doesn't start with a digit.");
  if (isReservedName(n)) throw new Error(`${n} is used by Tether or the system and can't be set here.`);
  if (typeof change.value !== "string") throw new Error("Give it a value.");
  if (change.value.includes("\0")) throw new Error("A value can't contain a NUL character.");
  await mutate((d) => {
    d.secrets[n] = { value: change.value!, updatedAt: Date.now() };
  });
  return listSecrets();
}

// ---------------- ${NAME} references ----------------

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** The secret names a text refers to as `${NAME}`. */
export function refsIn(text: string): string[] {
  return [...text.matchAll(REF)].map((m) => m[1]!);
}

/**
 * `${NAME}` and `${NAME:-default}` → the secret's value. A name that isn't one of your secrets is
 * left as written, default and all: the harness may expand it from its own env, as it did before
 * you had any secrets.
 */
export function resolveRefs(text: string, env: Record<string, string> = secretEnv()): string {
  return text.replace(REF, (whole, name: string) => (name in env ? env[name]! : whole));
}

const resolveMap = (m: Record<string, string>, env: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, resolveRefs(v, env)]));

/**
 * A registry server as a session launch gets it: `${NAME}` resolved in env values and headers, and
 * (stdio) every secret in its environment under the server's own variables.
 */
export function withSecrets(t: McpTransport, env: Record<string, string> = secretEnv()): McpTransport {
  if (!Object.keys(env).length) return t;
  if (t.type === "stdio") return { ...t, env: { ...env, ...resolveMap(t.env, env) } };
  return { ...t, headers: resolveMap(t.headers, env) };
}
