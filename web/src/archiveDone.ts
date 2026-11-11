// "Archive done sessions" on Home (the homeAgentCheckIn op): the words for its button and result.

import type { CheckInRow, CheckInStatus } from "../../shared/protocol";

const sessions = (n: number) => `${n} session${n === 1 ? "" : "s"}`;

/** The button's label: what a press does, or the check-in that's running. */
export function archiveDoneLabel(status: CheckInStatus | undefined, starting: boolean): string {
  if (status?.running) return `Checking ${sessions(status.running.asked)}…`;
  if (starting) return "Checking sessions…";
  return "Archive done sessions";
}

export type CheckInResult = NonNullable<CheckInStatus["last"]>;
export type ResultKind = "archived" | "kept" | "skipped";

/** One line on top of a result. */
export function resultHeadline(r: CheckInResult): string {
  const asked = r.archived.length + r.kept.length;
  if (!asked && !r.skipped.length) return "No recent sessions to check.";
  if (!asked) return `None of ${sessions(r.skipped.length)} could be asked right now.`;
  if (!r.archived.length) return `Asked ${sessions(asked)}; none were done, so nothing was archived.`;
  return `Archived ${r.archived.length} of ${sessions(asked)} asked.`;
}

/** Every row of a result, archived first, each with what happened to it. */
export function resultRows(r: CheckInResult): (CheckInRow & { kind: ResultKind })[] {
  return [
    ...r.archived.map((x) => ({ ...x, kind: "archived" as const })),
    ...r.kept.map((x) => ({ ...x, kind: "kept" as const })),
    ...r.skipped.map((x) => ({ ...x, kind: "skipped" as const })),
  ];
}

export const RESULT_LABELS: Record<ResultKind, string> = { archived: "Archived", kept: "Not archived", skipped: "Not asked" };
