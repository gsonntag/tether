// The MCP registry: Tether's canonical list of the user's MCP servers (docs/harness-platform.md,
// Phase 2), kept in the runner's config dir (paths.ts), never in a harness config. Servers come from
// the import (every harness's own config, sources.ts) or are added by hand; each one is global or
// tied to one repo (context/repokey.ts), on or off, and trusted or not (the guard).
//
// Env values and headers can be secrets: the file is mode 600 and nothing here logs them.

import { readFileSync, statSync } from "node:fs";
import type { McpTransport } from "../../../web/src/shared/protocol";
import { Mutex } from "../context/git";
import { writeAtomic } from "../context/store";
import { cleanName, identity } from "./formats";
import { serversFile } from "./paths";

export interface RegistryServer {
  id: string;
  /** the key it gets in every harness config (unique in the registry) */
  name: string;
  transport: McpTransport;
  /** "global" or "repo:<repo-key>" */
  scope: string;
  enabled: boolean;
  /** the guard allows its tools without the judge or a person */
  trusted: boolean;
  /** provenance: "claude:~/.claude.json", "repo:~/x/.mcp.json", "you", … */
  sources: string[];
  /** other names it has in harness configs (the guard knows its tools by those too) */
  aliases?: string[];
  addedAt: number;
  // OAuth: tokens live in tokens.json keyed by `id` (oauth.ts); only a session launch attaches them.
}

export interface RegistryData {
  servers: RegistryServer[];
  /** identities the user deleted: an import doesn't bring them back (adding one by hand does) */
  dismissed: string[];
}

let cache: { mtime: number; data: RegistryData } | undefined;

/** The registry as on disk (cached until the file changes). */
export function load(): RegistryData {
  let mtime = -1;
  try {
    mtime = statSync(serversFile()).mtimeMs;
  } catch {}
  if (cache && cache.mtime === mtime && mtime >= 0) return cache.data;
  let data: RegistryData = { servers: [], dismissed: [] };
  try {
    const v = JSON.parse(readFileSync(serversFile(), "utf8"));
    if (v && Array.isArray(v.servers)) data = { servers: v.servers, dismissed: Array.isArray(v.dismissed) ? v.dismissed : [] };
  } catch {}
  cache = mtime >= 0 ? { mtime, data } : undefined;
  return data;
}

function save(data: RegistryData) {
  writeAtomic(serversFile(), JSON.stringify(data, null, 2) + "\n", 0o600);
  cache = undefined;
}

const lock = new Mutex();

/** A read-modify-write of the registry, one at a time. */
export function mutate<T>(fn: (data: RegistryData) => T | Promise<T>): Promise<T> {
  return lock.run(async () => {
    const data = structuredClone(load());
    const r = await fn(data);
    save(data);
    return r;
  });
}

export const newServerId = () => `mcp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** `name`, or `name-2`, `name-3`… when another server already has it. */
export function uniqueName(data: RegistryData, name: string, except?: string): string {
  const base = cleanName(name);
  const taken = new Set(data.servers.filter((s) => s.id !== except).map((s) => s.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

export const findByIdentity = (data: RegistryData, t: McpTransport) => {
  const id = identity(t);
  return data.servers.find((s) => identity(s.transport) === id);
};

/** For tests: forget the cached file. */
export function resetCache() {
  cache = undefined;
}
