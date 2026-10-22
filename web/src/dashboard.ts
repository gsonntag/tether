// The Home dashboard's data: session pulses from every connected runner (grouped into the three
// states by recentSessions.ts), and answering what waits on you. Pure, so it's unit tested
// (dashboard.test.ts).

import { ACTIVITY_KINDS, type AgentNotice, type MemoryConflict, type SessionPulse, type UiRequest, type UiResponse } from "./shared/protocol";
import type { Entry } from "./shared/recentSessions";
import { fmtWhen } from "./shared/schedule";

/** runnerId -> sessionId -> latest pulse */
export type PulseMap = Record<string, Record<string, SessionPulse>>;

/** Applies pushed pulses: newest wins; archived (removed) sessions leave. */
export function mergePulses(map: PulseMap, runnerId: string, pulses: SessionPulse[]): PulseMap {
  const forRunner = { ...map[runnerId] };
  for (const p of pulses) {
    if (p.session.archived) delete forRunner[p.session.id];
    else forRunner[p.session.id] = p;
  }
  return { ...map, [runnerId]: forRunner };
}

export interface PulseRow {
  runnerId: string;
  pulse: SessionPulse;
}

export interface NeedRow extends PulseRow {
  request: UiRequest;
}

/** "2 agents · 1 shell · 1 scheduled · Next run 14:20" (the last: Tether's loops and schedules) */
export function activityLine(p: SessionPulse, now = Date.now()): string {
  const parts = ACTIVITY_KINDS.filter((k) => p.activity?.[k.id]).map((k) => {
    const n = p.activity![k.id]!;
    return `${n} ${n === 1 ? k.label : k.plural}`;
  });
  if (p.armed) parts.push(`${p.armed} scheduled`);
  if (p.nextRun) parts.push(`Next run ${fmtWhen(p.nextRun.at, now)}`);
  return parts.join(" · ");
}

/** "45s", "12m", "1h 05m" */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "+42 −3", or nothing when nothing changed. */
export function diffLabel(p: SessionPulse): string | undefined {
  const d = p.diffStat;
  if (!d || (!d.additions && !d.deletions)) return undefined;
  return `+${d.additions} −${d.deletions}`;
}

/** Context used, 0-100, when known. */
export function contextPercent(p: SessionPulse): number | undefined {
  const c = p.context;
  return c?.used !== undefined && c.max ? Math.min(100, (c.used / c.max) * 100) : undefined;
}

/** Requests being answered from this tab, by runner, session and request id. */
const answering = new Set<string>();

/**
 * Answers one waiting request from Home: the response carries the request's own id to the runner
 * and session it came from, so it can only ever settle that request. A second tap (or another
 * button) while the first is in flight sends nothing ("busy"); "stale" when the runner had nothing
 * waiting with that id (answered on another device, expired, cancelled). Rejects on rpc errors.
 */
export async function answerRequest(
  row: NeedRow,
  response: Omit<UiResponse, "id">,
  rpc: (runnerId: string, args: { sessionId: string; response: UiResponse }) => Promise<{ stale?: boolean }>,
): Promise<"ok" | "stale" | "busy"> {
  const key = `${row.runnerId}\n${row.pulse.session.id}\n${row.request.id}`;
  if (answering.has(key)) return "busy";
  answering.add(key);
  try {
    const r = await rpc(row.runnerId, { sessionId: row.pulse.session.id, response: { ...response, id: row.request.id } });
    return r?.stale ? "stale" : "ok";
  } finally {
    answering.delete(key);
  }
}

/** Longest option label Home answers with a button. */
const SHORT_OPTION = 32;

/** A question answerable with one tap: a single, single-choice question with a few short options. */
export function oneTapQuestion(r: UiRequest) {
  if (r.kind !== "question" || r.questions?.length !== 1) return undefined;
  const q = r.questions[0]!;
  return !q.multiSelect && q.options.length > 0 && q.options.length <= 4 && q.options.every((o) => o.label.length <= SHORT_OPTION) ? q : undefined;
}

type ToolInput = { command?: unknown; cmd?: unknown; file_path?: unknown; path?: unknown; summary?: unknown; truncated?: boolean } | undefined;
const str = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join(" ") : undefined);

/** A permission request's call: the shell command, or the path it touches, or what it says it does. */
export function requestCall(r: UiRequest): { text?: string; shell: boolean } {
  const i = r.tool?.input as ToolInput;
  const cmd = str(i?.command) ?? str(i?.cmd);
  if (cmd) return { text: cmd, shell: true };
  return { text: str(i?.file_path) ?? str(i?.path) ?? str(i?.summary), shell: false };
}

/** A call too long to show in full on Home: approved from the session, where it is. */
export const requestTruncated = (r: UiRequest) => !!(r.tool?.input as ToolInput)?.truncated;

const EDIT_TOOLS = /^(edit|multiedit|write|notebookedit|apply_patch|str_replace\w*|create|write_file|edit_file)$/i;

/** "wants to run", "wants to edit", "wants to use WebFetch". */
export function permissionVerb(r: UiRequest): string {
  if (requestCall(r).shell) return "wants to run";
  const name = r.tool?.name ?? "";
  if (EDIT_TOOLS.test(name)) return "wants to edit";
  return name ? `wants to use ${name}` : "asks to go ahead";
}

/** The guard's note on a permission request (the runner's "⚠ reason", or a hook's reason), without the mark. */
export function guardNote(r: UiRequest): string | undefined {
  const m = r.kind === "permission" ? r.message?.replace(/^\s*⚠\uFE0F?\s*/, "").trim() : undefined;
  return m || undefined;
}

/** A blocked call that is a shell command (Run it myself runs it): anything but "<Tool> <path>". */
export const isShellCall = (call: string | undefined) => !!call && !/^(?:[A-Z][A-Za-z]*|mcp__\S+)(?:\s|$)/.test(call.trim());

/** "Blocked by the judge: <reason>", by who blocked it. */
export function blockedLine(n: Pick<AgentNotice, "by" | "reason" | "body">): string {
  if (!n.by) return n.reason || n.body;
  const who = n.by === "judge" ? "the judge" : n.by === "hook" ? "a hook" : "a rule";
  return n.reason ? `Blocked by ${who}: ${n.reason}` : `Blocked by ${who}`;
}

export const firstLine = (text: string | undefined) => text?.split("\n").map((l) => l.trim()).find(Boolean);

/** What a waiting request asks, in one line. */
export function requestLine(r: UiRequest): string {
  if (r.kind === "permission") {
    const i = r.tool?.input as { command?: string; file_path?: string; summary?: string } | undefined;
    const what = i?.command ?? i?.file_path ?? i?.summary;
    return `${r.tool?.name ?? "Tool"}${what ? `: ${what}` : ""}`;
  }
  if (r.kind === "question") return r.questions?.[0]?.question ?? r.title;
  if (r.kind === "plan") return firstLine(r.message) ?? "The agent has a plan for you to review";
  return [r.title, r.message].filter(Boolean).join(": ");
}

// ---------------- the inbox ----------------

/** The inbox's kinds, in the order they rank. */
export type InboxKind = "permission" | "ask" | "blocked" | "memory" | "finished";
const RANK: Record<InboxKind, number> = { permission: 0, ask: 1, blocked: 2, memory: 3, finished: 4 };

/** One thing on Home's inbox: a waiting request, a notice, or a memory conflict. */
export interface InboxRow {
  kind: InboxKind;
  /** unique on the page (runner, session, request or notice) */
  key: string;
  /** when it started waiting (requests) or arrived (notices) */
  at: number;
  runnerId: string;
  /** the session it is about (all but memory conflicts) */
  entry?: Entry;
  /** a request answerable here */
  request?: UiRequest;
  /** the notice it is (blocked, finished) or that came with it */
  notice?: AgentNotice;
  conflict?: MemoryConflict;
}

/**
 * The inbox order: permission requests, oldest first; then questions, confirms and plan reviews,
 * oldest first; then blocked calls, newest first; then memory conflicts, newest first; then
 * finished turns, newest first. What's waited on longest leads where something is stalled.
 */
export function rankInbox<T extends Pick<InboxRow, "kind" | "at" | "key">>(rows: T[]): T[] {
  const oldestFirst = (k: InboxKind) => k === "permission" || k === "ask";
  return [...rows].sort((a, b) => RANK[a.kind] - RANK[b.kind] || (oldestFirst(a.kind) ? a.at - b.at : b.at - a.at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Rows shown before "Show all N". */
export const INBOX_ROWS = 12;

/** Home's heading. */
export const inboxTitle = (n: number) => (n ? `${n} to do` : "Nothing waiting");

/** Blocking: a row an agent waits on (Finished is not; it only waits for a look). The sidebar's Home badge counts these. */
export const isBlocking = (r: Pick<InboxRow, "kind">) => r.kind !== "finished";

/**
 * The inbox rows of the Needs you sessions and the open memory conflicts, ranked. `noticeOf`: the
 * session's latest notice; `since`: when a request was first seen waiting (remembered by the
 * caller; `fallback` the first time).
 */
export function buildInbox(
  needs: Entry[],
  conflicts: { runnerId: string; conflict: MemoryConflict }[],
  noticeOf: (e: Entry) => AgentNotice | undefined,
  since: (key: string, fallback: number) => number,
  now: number,
): InboxRow[] {
  const rows: InboxRow[] = [];
  for (const e of needs) {
    const runnerId = e.runnerId ?? "";
    const s = e.session;
    const n = noticeOf(e);
    const reqs = s.live ? (e.pulse?.pendingUi ?? []) : [];
    if (reqs.length) {
      for (const r of reqs) {
        const key = `${runnerId}:${s.id}:${r.id}`;
        // A question notice that came with it says when it started; else when this page first saw it.
        const asked = n && (n.kind === "question" || n.requestId === r.id) && n.ts <= now ? n.ts : now;
        rows.push({ kind: r.kind === "permission" ? "permission" : "ask", key, at: since(key, asked), runnerId, entry: e, request: r, notice: n?.requestId === r.id ? n : undefined });
      }
      continue;
    }
    const kind: InboxKind = s.live && s.needsInput ? "ask" : n?.kind === "blocked" ? "blocked" : n?.kind === "question" ? "ask" : "finished";
    rows.push({ kind, key: `${runnerId}:${s.id}`, at: n?.ts ?? s.updatedAt, runnerId, entry: e, notice: n });
  }
  for (const { runnerId, conflict } of conflicts) rows.push({ kind: "memory", key: `${runnerId}:memory:${conflict.id}`, at: conflict.ts, runnerId, conflict });
  return rankInbox(rows);
}
