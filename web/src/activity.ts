// What a session has going on (subagents, shells, …), summarized for the bar and the Running page.

import { ACTIVITY_KINDS, type ActivityItem, type ActivityKind, type LiveState } from "./shared/protocol";

/** The session's activity; older runners only send a flat list of background tasks. */
export function activityOf(state: LiveState | undefined): ActivityItem[] {
  if (!state) return [];
  if (state.activity) return state.activity;
  return (state.background ?? []).map((b) => ({
    id: b.id,
    // `type` was the task type, or a subagent's agent type ("general-purpose")
    kind: b.type === "local_bash" ? "shell" : b.type && (b.type === "local_agent" || !b.type.startsWith("local_")) ? "subagent" : "other",
    title: b.description,
    status: "running",
    startedAt: Date.now(),
  }));
}

const kindInfo = (k: ActivityKind) => ACTIVITY_KINDS.find((x) => x.id === k)!;
const count = (n: number, k: ActivityKind) => `${n} ${n === 1 ? kindInfo(k).label : kindInfo(k).plural}`;

/** "3 agents · 2 shells", running first; "1 scheduled" for armed ones. */
export function activitySummary(items: ActivityItem[]): string {
  const running = items.filter((a) => a.status === "running");
  const waiting = items.filter((a) => a.status === "waiting");
  const parts = ACTIVITY_KINDS.map((k) => [k.id, running.filter((a) => a.kind === k.id).length] as const)
    .filter(([, n]) => n)
    .map(([k, n]) => count(n, k));
  if (waiting.length) parts.push(`${waiting.length} waiting`);
  return parts.join(" · ");
}
