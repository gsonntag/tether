// Discovery and history from the Codex daemon's thread store (SPEC §4, §6): threads started in
// Codex's TUI, by `codex exec`, by Tether or any other client all show up, with their history.
// Read-only: listing and reading never loads a thread.

import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Msg, ProjectInfo, SessionSummary } from "../../../../shared/transcript";
import { call } from "./daemon";
import { agentName, historyMsgs } from "./items";

/** Thread sources listed as sessions (Codex's default leaves out app-server clients such as Tether). */
const SOURCES = ["cli", "vscode", "exec", "appServer"];
const SUBAGENT_SOURCES = ["subAgent", "subAgentThreadSpawn", "subAgentOther", "subAgentReview", "subAgentCompact"];
/** A new thread Tether names so Codex's TUI can join it before its first turn (driver.ts): not a title. */
export const PLACEHOLDER_NAME = "New session";

const firstLine = (s: string, n = 120) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** A thread's title: its name, else its first message. */
export function titleOf(t: any): string {
  const name = typeof t?.name === "string" && t.name !== PLACEHOLDER_NAME ? t.name : "";
  return name || firstLine(t?.preview ?? "") || (t?.parentThreadId ? (agentName(t) ?? "Subagent") : "New session");
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

let cache: { at: number; threads: any[] } | undefined;
const CACHE_MS = 5_000;

export async function codexProjects(): Promise<ProjectInfo[]> {
  const threads = cache && Date.now() - cache.at < CACHE_MS ? cache.threads : await listThreads();
  cache = { at: Date.now(), threads };
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
  return (await listThreads({ cwd: opts.projectPath, since: opts.since })).map(summaryOf);
}

/** A thread's metadata (no turns); undefined when the daemon doesn't know it. */
export async function readThread(nativeId: string): Promise<any | undefined> {
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

/** Forget the cached thread list (a thread was created). */
export function dropCache() {
  cache = undefined;
}
