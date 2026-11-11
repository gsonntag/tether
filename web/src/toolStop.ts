import type { LiveState, ToolPart } from "../../shared/transcript";

/**
 * A command the agent is waiting on, in a turn Tether drives: Stop on its card ends the turn, as
 * Esc in the composer does. Not while it waits on your answer (the dock answers that).
 */
export function stoppable(p: ToolPart, state: Pick<LiveState, "mode" | "status"> | undefined, waiting = false): boolean {
  return p.kind === "shell" && p.status === "running" && !waiting && state?.mode === "live" && state.status === "running";
}
