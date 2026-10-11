// How a session's goal (/goal, runner/src/goal.ts) reads: shared by the runner's notices and
// the goal tools, and the goal line at the top of a session.

import type { GoalBudget, GoalStatus, SessionGoal } from "./protocol";

export const STATUS_LABEL: Record<GoalStatus, string> = { active: "Active", paused: "Paused", done: "Done", blocked: "Blocked", budget: "Out of budget" };

export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "20 turns · 2M tokens · 2h 00m" */
export function fmtBudget(b: GoalBudget): string {
  return [b.turns ? `${b.turns} turns` : "", b.tokens ? `${fmtTokens(b.tokens)} tokens` : "", b.ms ? fmtDuration(b.ms) : ""].filter(Boolean).join(" · ");
}

/** "3 of 20 turns · 1.2M of 2M tokens", for the budget parts that were set; undefined without a budget. */
export function budgetUsed(g: SessionGoal): string | undefined {
  const b = g.budget;
  if (!b) return undefined;
  const parts = [
    b.turns ? `${g.used.turns} of ${b.turns} turns` : "",
    b.tokens ? `${fmtTokens(g.used.tokens)} of ${fmtTokens(b.tokens)} tokens` : "",
    b.ms ? `${fmtDuration(g.used.ms)} of ${fmtDuration(b.ms)}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

/** The goal line's status: "Active · 3 of 20 turns" (the budget part only when one was set). */
export function goalSummary(g: SessionGoal): string {
  return [STATUS_LABEL[g.status], budgetUsed(g)].filter(Boolean).join(" · ");
}
