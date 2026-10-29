// Discovery and history from the Codex daemon's thread store (SPEC §4, §6): threads started in
// Codex's TUI, by `codex exec`, by Tether or any other client all show up, with their history.
// Read-only: listing and reading never loads a thread.

import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Msg, ProjectInfo, SessionSummary } from "../../../../shared/transcript";
import { call } from "./daemon";
import type { StartOpts } from "../../core/adapter";
import { titleText } from "../../../../shared/fromTether";
import { agentName, historyMsgs } from "./items";
import { modeOf, sandboxOf, UNKNOWN_MODE } from "./modes";
import { remember, remembered } from "./remember";

/** Thread sources listed as sessions (Codex's default leaves out app-server clients such as Tether). */
const SOURCES = ["cli", "vscode", "exec", "appServer"];
const SUBAGENT_SOURCES = ["subAgent", "subAgentThreadSpawn", "subAgentOther", "subAgentReview", "subAgentCompact"];
/** A new thread Tether names so Codex's TUI can join it before its first turn (driver.ts): not a title. */
export const PLACEHOLDER_NAME = "New session";

const firstLine = (s: string, n = 120) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** A thread's title: its name, else its first message. */
export function titleOf(t: any): string {
  const name = typeof t?.name === "string" && t.name !== PLACEHOLDER_NAME ? t.name : "";
  return name || firstLine(titleText(t?.preview ?? "")) || (t?.parentThreadId ? (agentName(t) ?? "Subagent") : "New session");
}

/** A thread as a sidebar row. */
export function summaryOf(t: any): SessionSummary {
  const parent = t.parentThreadId ?? t.source?.subAgent?.thread_spawn?.parent_thread_id;
  const role = t.agentRole ?? t.source?.subAgent?.thread_spawn?.agent_role;
  return {
    id: `codex:${t.id}`,
    harness: "codex",
    nativeId: t.id,
    projectPath: t.cwd,
    title: parent ? (agentName(t) ?? "Subagent") : titleOf(t),
    mode: "stored",
    status: "idle",
    updatedAt: (t.updatedAt ?? t.recencyAt ?? t.createdAt ?? 0) * 1000,
    ...(parent ? { parentSessionId: `codex:${parent}` } : {}),
    ...(role ? { agentType: role } : {}),
  };
}

/** Threads, newest first; stops paging at `since` (ms) or `max`. */
export async function listThreads(o: { cwd?: string; since?: number; max?: number; parent?: string } = {}): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | null = null;
  const max = o.max ?? 2000;
  for (let page = 0; page < 40; page++) {
    const r: any = await call("thread/list", {
      cursor,
      limit: 100,
      sortKey: "updated_at",
      sourceKinds: o.parent ? SUBAGENT_SOURCES : SOURCES,
      ...(o.cwd ? { cwd: o.cwd } : {}),
      ...(o.parent ? { parentThreadId: o.parent } : {}),
    });
    for (const t of r?.data ?? []) {
      if (!o.parent && (t.parentThreadId || t.ephemeral)) continue;
      if (o.since && (t.updatedAt ?? 0) * 1000 < o.since) return out;
      out.push(t);
    }
    if (!(cursor = r?.nextCursor) || out.length >= max) break;
  }
  return out.slice(0, max);
}

/**
 * Listing threads is slow on a big store (thread/list can take 10–20 s), so lists are shared: one
 * call at a time per kind of list, and the result kept a while. The runner's background discovery
 * (a `since` list) is kept for a minute; a folder list someone opened, a few seconds.
 */
const lists = new Map<string, { at: number; p: Promise<any[]> }>();
const LIST_MS = 5_000;
export const DISCOVERY_MS = 60_000;

function sharedList(key: string, maxAge: number, load: () => Promise<any[]>): Promise<any[]> {
  const had = lists.get(key);
  if (had && Date.now() - had.at < maxAge) return had.p;
  const p = load();
  lists.set(key, { at: Date.now(), p });
  p.catch(() => lists.get(key)?.p === p && lists.delete(key));
  return p;
}

export async function codexProjects(): Promise<ProjectInfo[]> {
  const threads = await sharedList("all", LIST_MS * 6, () => listThreads());
  const by = new Map<string, ProjectInfo>();
  for (const t of threads) {
    if (!t.cwd) continue;
    const p = by.get(t.cwd) ?? { path: t.cwd, name: basename(t.cwd) || t.cwd, harnesses: ["codex"], updatedAt: 0, sessions: 0 };
    p.sessions++;
    p.updatedAt = Math.max(p.updatedAt, (t.updatedAt ?? 0) * 1000);
    by.set(t.cwd, p);
  }
  return [...by.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function codexSessions(opts: { projectPath?: string; since?: number } = {}): Promise<SessionSummary[]> {
  // Discovery's `since` moves every pass; a minute-old list from a slightly earlier `since` is as good.
  const key = opts.projectPath ? `cwd:${opts.projectPath}` : opts.since ? "recent" : "all";
  const threads = await sharedList(key, opts.since && !opts.projectPath ? DISCOVERY_MS : LIST_MS, () => listThreads({ cwd: opts.projectPath, since: opts.since }));
  return threads.map(summaryOf);
}

/** Reads of one thread a moment apart (opening a session reads it for its row and its settings) share one call. */
const reads = new Map<string, { at: number; p: Promise<any | undefined> }>();
const READ_SHARE_MS = 2_000;

/** A thread's metadata (no turns); undefined when the daemon doesn't know it. */
export function readThread(nativeId: string): Promise<any | undefined> {
  const now = Date.now();
  for (const [k, v] of reads) if (now - v.at > READ_SHARE_MS) reads.delete(k);
  const had = reads.get(nativeId);
  if (had) return had.p;
  const p = readThreadNow(nativeId);
  reads.set(nativeId, { at: now, p });
  p.catch(() => reads.delete(nativeId));
  return p;
}

async function readThreadNow(nativeId: string): Promise<any | undefined> {
  try {
    return (await call("thread/read", { threadId: nativeId, includeTurns: false }))?.thread;
  } catch (e: any) {
    if (/not found|no rollout|invalid/i.test(String(e?.message))) return undefined;
    throw e;
  }
}

export async function codexSessionInfo(nativeId: string): Promise<SessionSummary | undefined> {
  const t = await readThread(nativeId);
  return t ? summaryOf(t) : undefined;
}

export async function codexSubagents(nativeId: string): Promise<SessionSummary[]> {
  return (await listThreads({ parent: nativeId, max: 200 })).map(summaryOf);
}

/** Every turn of a thread, oldest first, with all their items. */
export async function threadTurns(nativeId: string): Promise<any[]> {
  const turns: any[] = [];
  let cursor: string | null = null;
  try {
    for (let page = 0; page < 200; page++) {
      const r: any = await call("thread/turns/list", { threadId: nativeId, cursor, limit: 100, sortDirection: "asc", itemsView: "full" });
      turns.push(...(r?.data ?? []));
      if (!(cursor = r?.nextCursor)) break;
    }
    return turns;
  } catch (e: any) {
    // An older daemon without paging: the whole thread at once.
    if (!/method|unknown|not found/i.test(String(e?.message)) || turns.length) throw e;
    const r: any = await call("thread/read", { threadId: nativeId, includeTurns: true });
    return r?.thread?.turns ?? [];
  }
}

export async function codexHistory(nativeId: string, projectPath: string): Promise<Msg[]> {
  const t = await readThread(nativeId);
  if (!t) return [];
  return historyMsgs(await threadTurns(nativeId), t.cwd ?? projectPath, t.model ?? undefined);
}

/** How often a watched stored thread's rollout file is checked for changes. */
const WATCH_MS = 1000;

/** Calls onChange with the whole transcript when the thread's rollout file changes. */
export function watchThread(nativeId: string, projectPath: string, onChange: (msgs: Msg[]) => void): () => void {
  let stopped = false;
  let path: string | undefined;
  let last: string | undefined;
  let busy = false;
  const check = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      path ??= (await readThread(nativeId).catch(() => undefined))?.path ?? undefined;
      const s = path ? await stat(path).catch(() => undefined) : undefined;
      const stamp = s ? `${s.size}:${s.mtimeMs}` : "";
      if (last !== undefined && stamp !== last) {
        const msgs = await codexHistory(nativeId, projectPath).catch(() => undefined);
        if (msgs && !stopped) onChange(msgs);
      }
      last = stamp;
    } finally {
      busy = false;
    }
  };
  void check();
  const t = setInterval(check, WATCH_MS);
  t.unref?.();
  return () => {
    stopped = true;
    clearInterval(t);
  };
}

/**
 * A thread's settings as its rollout last recorded them (its newest turn_context): model, effort,
 * approval policy and sandbox. Undefined fields: not recorded (a thread with no turn yet).
 */
export function rolloutSettings(text: string): { model?: string; effort?: string; approvalPolicy?: string; sandbox?: string; at?: number } {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!l.includes('"turn_context"')) continue;
    try {
      const m = JSON.parse(l);
      if (m?.type !== "turn_context") continue;
      const p = m.payload ?? {};
      const at = Date.parse(m.timestamp ?? "");
      return {
        ...(Number.isFinite(at) ? { at } : {}),
        ...(typeof p.model === "string" ? { model: p.model } : {}),
        ...(typeof p.effort === "string" ? { effort: p.effort } : {}),
        ...(typeof p.approval_policy === "string" ? { approvalPolicy: p.approval_policy } : {}),
        ...(sandboxOf(p.sandbox_policy) ? { sandbox: sandboxOf(p.sandbox_policy) } : {}),
      };
    } catch {}
  }
  return {};
}

/** How much of a rollout's end is read for its settings. */
const SETTINGS_TAIL = 2_000_000;

/** A stored thread's own settings (its rollout, else its metadata). */
export async function threadSettings(nativeId: string): Promise<StartOpts | undefined> {
  const t = await readThread(nativeId);
  if (!t) return undefined;
  const r = await rolloutOf(t);
  // Changed (and confirmed) while Tether was on it, after its last turn: that's newer than the rollout.
  const applied = remembered(nativeId)?.applied;
  if (applied && (!r.at || applied.at > r.at)) {
    const { at: _, ...rest } = applied;
    return { ...rest, permissionMode: rest.permissionMode ?? UNKNOWN_MODE };
  }
  if (r.approvalPolicy) {
    // Its first turn recorded them: what Tether remembered from its start isn't needed any more.
    if (remembered(nativeId)?.start) remember(nativeId, { start: undefined });
    const model = r.model ?? t.model ?? undefined;
    const effort = r.effort ?? t.reasoningEffort ?? undefined;
    const mode = modeOf(r.approvalPolicy, r.sandbox);
    return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), permissionMode: mode ?? UNKNOWN_MODE };
  }
  // No turn yet: what Tether started it with, if Tether did; else not known (never Codex's config,
  // which may not be what the thread has).
  const start = remembered(nativeId)?.start ?? {};
  const model = start.model ?? t.model ?? undefined;
  const effort = start.effort ?? t.reasoningEffort ?? undefined;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), permissionMode: start.permissionMode ?? UNKNOWN_MODE };
}

/** A thread's settings as its rollout's end records them. */
async function rolloutOf(t: any): Promise<ReturnType<typeof rolloutSettings>> {
  if (typeof t?.path !== "string") return {};
  const f = Bun.file(t.path);
  return rolloutSettings(await f.slice(Math.max(0, f.size - SETTINGS_TAIL)).text().catch(() => ""));
}

/** Whether a thread's first turn has recorded its settings. */
export async function hasTurnContext(t: any): Promise<boolean> {
  return !!(await rolloutOf(t)).approvalPolicy;
}

/** Forget the cached thread list (a thread was created). */
export function dropCache() {
  lists.clear();
}
