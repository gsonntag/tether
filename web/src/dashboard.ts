// The Home dashboard's data: session pulses from every connected runner, grouped into what needs
// you, what's running and what finished recently. Pure, so it's unit tested (dashboard.test.ts).

import { ACTIVITY_KINDS, byRecent, type SessionPulse, type UiRequest, type UiResponse } from "./shared/protocol";

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

export interface Dashboard {
  needs: NeedRow[];
  running: PulseRow[];
  finished: PulseRow[];
}

/** Doing something now: a turn, a wait, a prompt, or subagents/shells/wakeups still going. */
export function isRunning(p: SessionPulse): boolean {
  if (!p.session.live) return false;
  return p.session.status !== "idle" || !!p.session.needsInput || !!p.pendingUi?.length || !!(p.activity && Object.keys(p.activity).length) || !!p.armed;
}

export function groupDashboard(map: PulseMap, opts: { finished?: number } = {}): Dashboard {
  const all: PulseRow[] = [];
  for (const [runnerId, byId] of Object.entries(map)) for (const pulse of Object.values(byId)) if (!pulse.session.archived) all.push({ runnerId, pulse });

  const needs: NeedRow[] = [];
  for (const row of all) if (row.pulse.session.live) for (const request of row.pulse.pendingUi ?? []) needs.push({ ...row, request });
  // Oldest waiting first: it has waited longest.
  needs.sort((a, b) => a.pulse.session.updatedAt - b.pulse.session.updatedAt);

  const running = all.filter((r) => isRunning(r.pulse));
  const rank = (p: SessionPulse) => (p.pendingUi?.length ? 0 : p.session.status === "running" ? 1 : p.session.status === "waiting" ? 2 : 3);
  running.sort((a, b) => rank(a.pulse) - rank(b.pulse) || (b.pulse.turnStartedAt ?? b.pulse.session.updatedAt) - (a.pulse.turnStartedAt ?? a.pulse.session.updatedAt));

  // Like the session lists: the most recent message first.
  const finished = all
    .filter((r) => !isRunning(r.pulse) && r.pulse.finishedAt)
    .sort((a, b) => byRecent(a.pulse.session, b.pulse.session))
    .slice(0, opts.finished ?? 8);

  return { needs, running, finished };
}

/** "2 agents · 1 shell · 1 scheduled" */
export function activityLine(p: SessionPulse): string {
  const parts = ACTIVITY_KINDS.filter((k) => p.activity?.[k.id]).map((k) => {
    const n = p.activity![k.id]!;
    return `${n} ${n === 1 ? k.label : k.plural}`;
  });
  if (p.armed) parts.push(`${p.armed} scheduled`);
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

/** Sessions doing something now on every runner: Home's Running count, and the sidebar's. */
export function runningCount(map: PulseMap): number {
  let n = 0;
  for (const byId of Object.values(map)) for (const p of Object.values(byId)) if (!p.session.archived && isRunning(p)) n++;
  return n;
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

/** A question answerable with one tap: a single, single-choice question with a few options. */
export function oneTapQuestion(r: UiRequest) {
  if (r.kind !== "question" || r.questions?.length !== 1) return undefined;
  const q = r.questions[0]!;
  return !q.multiSelect && q.options.length > 0 && q.options.length <= 4 ? q : undefined;
}

/** What a waiting request asks, in one line. */
export function requestLine(r: UiRequest): string {
  if (r.kind === "permission") {
    const i = r.tool?.input as { command?: string; file_path?: string; summary?: string } | undefined;
    const what = i?.command ?? i?.file_path ?? i?.summary;
    return `${r.tool?.name ?? "Tool"}${what ? `: ${what}` : ""}`;
  }
  if (r.kind === "question") return r.questions?.[0]?.question ?? r.title;
  if (r.kind === "plan") return "The agent has a plan for you to review";
  return [r.title, r.message].filter(Boolean).join(": ");
}
