// The MCP registry's operations: import (every harness's config, merged by command line or URL),
// add from pasted text, on/off, trusted, delete; what a session gets injected; what the web app
// shows; and which registry server a tool call belongs to (the guard's trusted rule). Every change
// is followed by the global export (export.ts), under the same lock.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES, type HarnessId, type McpAuthStart, type McpAuthStatus, type McpDelivery, type McpFindResult, type McpServerView } from "../../../web/src/shared/protocol";
import { connectorFor, connectors } from "../connectors";
import type { SessionServer } from "../connectors/types";
import { tilde } from "../context/paths";
import { isHome, repoKey } from "../context/repokey";
import { exportedTo, exportRegistry, type RegistryExport } from "./export";
import { cleanName, identity, parsePaste, summary } from "./formats";
import { authorizable, authorized, authStatus, checkUnknown, finishAuth, forget, readTokens, recordFor, signOut, startAuth } from "./oauth";
import { claudeProjects, merge, repoServers, type Found, type Scan } from "./sources";
import { findByIdentity, load, mutate, newServerId, uniqueName, type RegistryData, type RegistryServer } from "./store";

// ---------------- import ----------------

/**
 * Every harness's servers (global configs, Claude's per-project ones) and the .mcp.json of each
 * project: `projects` (the runner's project list) and every project in ~/.claude.json.
 */
export function scanAll(projects: string[] = []): Scan {
  const scans: Scan[] = [];
  for (const c of Object.values(connectors)) {
    // Claude's per-project entries come in through importGlobal too (claudeServers with projects).
    const s = c.mcp.importGlobal?.();
    if (s) scans.push(s);
  }
  const dirs = new Set([...projects, ...claudeProjects()]);
  for (const d of dirs) if (existsSync(join(d, ".mcp.json")) && !isHome(d)) scans.push(repoServers(d));
  return merge(...scans);
}

/** "global" or "repo:<key>" for a found entry (a project in $HOME itself counts as global). */
async function scopeOf(f: Found): Promise<string> {
  if (f.scope === "global" || isHome(f.scope.path)) return "global";
  return `repo:${await repoKey(f.scope.path)}`;
}

interface Resolved extends Found {
  key: string;
}

/** Merges found entries into the registry; returns the names added. Never imports Tether's own exports. */
export function mergeFound(data: RegistryData, found: Resolved[]): string[] {
  const added: string[] = [];
  const dismissed = new Set(data.dismissed);
  for (const f of found) {
    if (f.ours) continue;
    const id = identity(f.transport);
    if (dismissed.has(id)) continue;
    const cur = findByIdentity(data, f.transport);
    if (cur) {
      if (!cur.sources.includes(f.source)) cur.sources.push(f.source);
      if (f.name !== cur.name && !(cur.aliases ?? []).includes(f.name)) cur.aliases = [...(cur.aliases ?? []), f.name];
      // Found in one harness globally and in another for a repo: it's global.
      if (f.key === "global" && cur.scope !== "global" && cur.sources.every((s) => s !== "you")) cur.scope = "global";
      continue;
    }
    const name = uniqueName(data, f.name);
    data.servers.push({
      id: newServerId(),
      name,
      transport: f.transport,
      scope: f.key,
      enabled: f.enabled,
      trusted: false,
      sources: [f.source],
      ...(name !== f.name ? { aliases: [f.name] } : {}),
      addedAt: Date.now(),
    });
    added.push(name);
  }
  return added;
}

async function resolve(found: Found[]): Promise<Resolved[]> {
  return Promise.all(found.map(async (f) => ({ ...f, key: await scopeOf(f) })));
}

/** What an import would add, by name (the master context's Import preview). Writes nothing. */
export async function previewImport(projects: string[] = []): Promise<{ names: string[]; warnings: string[] }> {
  const scan = scanAll(projects);
  const data = structuredClone(load());
  const names = mergeFound(data, await resolve(scan.found));
  return { names, warnings: scan.warnings };
}

/** "Find servers" (and the master context's Import): imports every harness's servers, then exports. */
export async function importServers(projects: string[] = []): Promise<McpFindResult & { export: RegistryExport }> {
  const scan = scanAll(projects);
  const found = await resolve(scan.found);
  const { added, exp } = await mutate((data) => {
    const added = mergeFound(data, found);
    return { added, exp: exportRegistry(data.servers) };
  });
  for (const w of [...scan.warnings, ...exp.warnings]) console.error(`mcp: ${w}`);
  await checkUnknown(load().servers, 3000);
  return { servers: views(), added, warnings: [...scan.warnings, ...exp.warnings], export: exp };
}

// ---------------- edits ----------------

async function scopeArg(scope?: string): Promise<string> {
  if (!scope || scope === "global") return "global";
  if (scope.startsWith("repo:")) return scope;
  return `repo:${await repoKey(scope)}`; // a project path
}

/** Adds servers from pasted text (formats.ts parsePaste). A server already there is turned on (and moved to `scope`). */
export async function addServers(text: string, opts: { name?: string; scope?: string } = {}): Promise<McpServerView[]> {
  const pasted = parsePaste(text, opts.name);
  const scope = await scopeArg(opts.scope);
  await mutate((data) => {
    for (const p of pasted) {
      const id = identity(p.transport);
      data.dismissed = data.dismissed.filter((d) => d !== id);
      const cur = findByIdentity(data, p.transport);
      if (cur) {
        cur.enabled = true;
        cur.scope = scope;
        if (!cur.sources.includes("you")) cur.sources.push("you");
        continue;
      }
      if (p.name === "tether-context") throw new Error("tether-context is Tether's own memory server");
      data.servers.push({ id: newServerId(), name: uniqueName(data, p.name), transport: p.transport, scope, enabled: true, trusted: false, sources: ["you"], addedAt: Date.now() });
    }
    report(exportRegistry(data.servers));
  });
  // Does a new URL server want a sign-in? (The rest finish in the background.)
  await checkUnknown(load().servers, 3000);
  return views();
}

/**
 * On/off, trusted, delete, or sign out (drops its OAuth tokens). Deleting removes only Tether's
 * own copies from harness configs, and its tokens.
 */
export async function setServer(id: string, change: { enabled?: boolean; trusted?: boolean; remove?: boolean; signOut?: boolean }): Promise<McpServerView[]> {
  if (change.signOut) {
    const s = load().servers.find((x) => x.id === id);
    if (!s) throw new Error("No such MCP server");
    await signOut(s);
  }
  if (change.remove) await forget(id);
  await mutate((data) => {
    const s = data.servers.find((x) => x.id === id);
    if (!s) throw new Error("No such MCP server");
    if (change.remove) {
      data.servers = data.servers.filter((x) => x !== s);
      const ident = identity(s.transport);
      if (!data.dismissed.includes(ident)) data.dismissed.push(ident);
    }
    if (change.enabled !== undefined) s.enabled = change.enabled;
    if (change.trusted !== undefined) s.trusted = change.trusted;
    if (change.remove || change.enabled !== undefined) report(exportRegistry(data.servers));
  });
  return views();
}

// ---------------- OAuth sign-in (oauth.ts) ----------------

/** Starts signing in to server `id` (the web app opens the returned page). */
export async function startServerAuth(id: string, opts: { runnerId: string; redirectUri: string; clientId?: string; clientSecret?: string }): Promise<McpAuthStart> {
  const s = load().servers.find((x) => x.id === id);
  if (!s) throw new Error("No such MCP server");
  return startAuth(s, opts);
}

/** Finishes a sign-in relayed by the app's callback. */
export function finishServerAuth(p: Parameters<typeof finishAuth>[0]) {
  return finishAuth(p, load().servers);
}

/** The list for the web app, after asking new URL servers whether they want a sign-in (waits briefly). */
export async function listServers(): Promise<McpServerView[]> {
  await checkUnknown(load().servers, 2500);
  return views();
}

function report(r: RegistryExport) {
  for (const w of r.warnings) console.error(`mcp: ${w}`);
  if (r.written.length) console.log(`mcp: updated ${r.written.map(tilde).join(", ")}`);
}

// ---------------- sessions ----------------

/** A server a session would get that still needs an OAuth sign-in (the session says so inline). */
export interface McpAuthNeed {
  id: string;
  name: string;
  status: Exclude<McpAuthStatus, "connected">;
}

/**
 * The registry servers a session of harness `h` in `projectPath` gets injected: on, global or this
 * repo's, and not already in the harness's own config (Decision 2: same command line or URL, or a
 * different server under the same name; the native entry wins and nothing is added).
 *
 * OAuth (Decision 8): a signed-in server gets `Authorization: Bearer <token>` here, refreshed first
 * when it runs out. Tether's own export of it (written without tokens) doesn't count as native for
 * that: the session's copy, with the token, goes in under the same name. `auth` lists the servers
 * this session would get (or Tether's export gives it) that still need a sign-in.
 */
export async function sessionMcp(h: HarnessId, projectPath: string): Promise<{ servers: SessionServer[]; auth: McpAuthNeed[] }> {
  const data = load();
  if (!data.servers.some((s) => s.enabled)) return { servers: [], auth: [] };
  const key = await repoKey(projectPath).catch(() => undefined);
  const list = data.servers.filter((s) => s.enabled && (s.scope === "global" || (key && s.scope === `repo:${key}`)));
  if (!list.length) return { servers: [], auth: [] };
  const c = connectorFor(h).mcp;
  let native: Found[] = [];
  try {
    native = c.native?.(projectPath) ?? [];
  } catch (e: any) {
    console.error(`mcp: couldn't read ${h}'s own MCP config: ${e?.message ?? e}`);
  }
  const tokens = readTokens();
  const out = await Promise.all(
    list.map(async (s) => {
      const id = identity(s.transport);
      const hits = native.filter((f) => identity(f.transport) === id || f.name === s.name);
      // The user's own entry (or a different server under this name): the harness's, untouched.
      if (hits.some((f) => !f.ours)) return {};
      const signedIn = authorizable(s) && !!recordFor(s, tokens)?.tokens;
      const a = signedIn ? await authorized(s) : { transport: s.transport, token: false, status: authorizable(s) ? authStatus(s, recordFor(s, tokens)) : undefined };
      const need = a.status && a.status !== "connected" && c.deliver(s.transport).how === "session" ? { id: s.id, name: s.name, status: a.status } : undefined;
      // Tether's export already gives it; only a token (under the export's own name) is worth a second copy.
      if (hits.length && !(a.token && hits.every((f) => f.name === s.name))) return { need };
      return { server: { name: s.name, transport: a.transport }, need };
    }),
  );
  return { servers: out.flatMap((o) => (o.server ? [o.server] : [])), auth: out.flatMap((o) => (o.need ? [o.need] : [])) };
}

/** The servers alone (see sessionMcp). */
export async function sessionServers(h: HarnessId, projectPath: string): Promise<SessionServer[]> {
  return (await sessionMcp(h, projectPath)).servers;
}

// ---------------- the web app's view ----------------

const LABEL = Object.fromEntries(HARNESSES.map((h) => [h.id, h.label])) as Record<HarnessId, string>;
const IDS = HARNESSES.map((h) => h.id);

/** How each harness gets one server, from its connector, its own config and what the export wrote. */
function delivery(s: RegistryServer, natives: Map<HarnessId, Found[]>, exported: Map<string, Set<string>>, tokens: ReturnType<typeof readTokens>): McpDelivery[] {
  return IDS.map((h): McpDelivery => {
    if (!s.enabled) return { harness: h, how: "none", note: "Turned off" };
    const own = natives.get(h)?.find((f) => !f.ours && (identity(f.transport) === identity(s.transport) || f.name === s.name));
    if (own) return identity(own.transport) === identity(s.transport) ? { harness: h, how: "native", note: `Already in ${LABEL[h]}'s own config (${own.name}); left as it is` } : { harness: h, how: "none", note: `${LABEL[h]}'s own config has a different server named ${s.name}` };
    const c = connectorFor(h).mcp;
    const route = c.deliver(s.transport);
    const files = (c.targets?.() ?? []).filter((t) => exported.get(s.name)?.has(t.file)).map((t) => tilde(t.file));
    if (route.how === "none") return { harness: h, how: "none", note: route.note };
    if (route.how === "global") {
      if (s.scope !== "global") return { harness: h, how: "none", note: `${route.note}; repo servers aren't written into global configs` };
      // Decision 8: the global config gets no token; the harness signs in to an OAuth server itself.
      const signIn = authorizable(s) && authStatus(s, recordFor(s, tokens)) ? `; without Tether's sign-in (${LABEL[h]} signs in itself)` : "";
      return files.length ? { harness: h, how: "global", note: `In ${files.join(", ")}${signIn}` } : { harness: h, how: "none", note: `${route.note}; not written yet (is ${LABEL[h]} set up here?)` };
    }
    return { harness: h, how: "session", note: files.length ? `${route.note}; also in ${files.join(", ")}` : route.note };
  });
}

function view(s: RegistryServer, natives: Map<HarnessId, Found[]>, exported: Map<string, Set<string>>, tokens: ReturnType<typeof readTokens>): McpServerView {
  const t = s.transport;
  return {
    id: s.id,
    name: s.name,
    scope: s.scope,
    enabled: s.enabled,
    trusted: s.trusted,
    type: t.type,
    summary: summary(t),
    envKeys: t.type === "stdio" ? Object.keys(t.env) : [],
    headerKeys: t.type === "stdio" ? [] : Object.keys(t.headers),
    sources: s.sources,
    delivery: delivery(s, natives, exported, tokens),
    // Not offered once the server took a request without credentials.
    ...(authorizable(s) && recordFor(s, tokens)?.required !== false ? { oauth: true, auth: authStatus(s, recordFor(s, tokens)) } : {}),
  };
}

/** The registry for the web app: env and header values stay here, only their names go out. */
export function views(): McpServerView[] {
  const data = load();
  if (!data.servers.length) return [];
  const natives = new Map<HarnessId, Found[]>();
  for (const h of IDS) {
    try {
      natives.set(h, connectorFor(h).mcp.importGlobal?.().found.filter((f) => f.scope === "global") ?? []);
    } catch {
      natives.set(h, []);
    }
  }
  const exported = exportedTo();
  const tokens = readTokens();
  return data.servers.map((s) => view(s, natives, exported, tokens));
}

// ---------------- the guard ----------------

/** What the guard's trusted rule needs to know about one session (sessionTrust). */
export interface McpTrust {
  /** trusted servers this session can have, with the names its harness knows each by */
  trusted: { server: RegistryServer; names: string[] }[];
  /** every server name in sight: the registry's and the harness's own configs' */
  known: string[];
}

/**
 * The trusted servers for a session of harness `h` in `projectPath`: on, global or this repo's,
 * and only under names the harness's own config doesn't give a different server (Decision 2: that
 * one runs, and the trust was given to Tether's). Undefined when nothing is trusted.
 */
export async function sessionTrust(h: HarnessId, projectPath: string): Promise<McpTrust | undefined> {
  const data = load();
  const candidates = data.servers.filter((s) => s.enabled && s.trusted);
  if (!candidates.length) return undefined;
  const key = await repoKey(projectPath).catch(() => undefined);
  let native: Found[] = [];
  try {
    native = connectorFor(h).mcp.native?.(projectPath) ?? [];
  } catch {}
  const trusted = candidates
    .filter((s) => s.scope === "global" || (key && s.scope === `repo:${key}`))
    .flatMap((s) => {
      const id = identity(s.transport);
      const names = [s.name, ...(s.aliases ?? [])].filter((n) => !native.some((f) => !f.ours && f.name === n && identity(f.transport) !== id));
      return names.length ? [{ server: s, names }] : [];
    });
  const known = [...new Set([...data.servers.flatMap((s) => [s.name, ...(s.aliases ?? [])]), ...native.map((f) => f.name)])];
  return { trusted, known };
}

const variants = (name: string) => [...new Set([name, name.replace(/-/g, "_"), cleanName(name).replace(/[^A-Za-z0-9_]/g, "_")])];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const flat = (n: string) => new RegExp(`^(mcp_|@)?${escape(n)}(_|__|/|\\.).+$`, "i");

/**
 * The trusted registry server a tool call belongs to, by the names harnesses give MCP tools:
 * `mcp__<server>__<tool>` (Claude Code, Codex), `<server>_<tool>` (opencode, pi-mcp-adapter's
 * direct tools), `mcp_<server>_<tool>`, `<server>/<tool>`, `@<server>/<tool>`, and pi-mcp-adapter's
 * `mcp({ server, tool })`. Only `isMcpLike` calls are matched, so a server name can't make a built-in
 * shell or edit tool look like one of its tools. In the flat schemes a longer known server name
 * that also fits wins (`github_enterprise_x` isn't trusted `github`'s). Nothing without `trust`.
 */
export function trustedServerFor(tool: string, input: any, isMcpLike: boolean, trust: McpTrust | undefined): RegistryServer | undefined {
  if (!trust?.trusted.length) return undefined;
  const known = trust.known.flatMap(variants);
  const longer = (n: string, t: string) => known.some((m) => m.length > n.length && flat(m).test(t));
  for (const { server: s, names } of trust.trusted) {
    for (const n of names.flatMap(variants)) {
      if (tool === "mcp") {
        if (input?.server === n) return s;
        const t = typeof input?.tool === "string" ? input.tool : "";
        if (t.startsWith(`${n}_`) && !longer(n, t)) return s;
      }
      if (new RegExp(`^mcp__${escape(n)}__.+$`, "i").test(tool)) return s;
      if (isMcpLike && flat(n).test(tool) && !longer(n, tool)) return s;
    }
  }
  return undefined;
}
