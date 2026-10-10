// The session mode picker: plan mode and the like, the same way for every harness (Claude Code
// default/plan, Codex default/plan, opencode build/plan, other ACP agents' own modes). Modes that
// approve tool calls by themselves never show: the guard picker decides approvals.

import { APPROVING_MODES, type LiveState } from "./shared/protocol";

/** The modes to offer for this session; empty when there's no real choice. */
export function pickerModes(st: Pick<LiveState, "modes" | "permissionMode">): string[] {
  const modes = (st.modes ?? []).filter((m) => !APPROVING_MODES.has(m));
  return modes.length > 1 ? modes : [];
}

const LABELS: Record<string, string> = { default: "Default", plan: "Plan", build: "Build", ask: "Ask", architect: "Architect", code: "Code" };

export function modeLabel(m: string): string {
  return LABELS[m] ?? m.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export const MODE_DESCRIPTIONS: Record<string, string> = {
  default: "Work on the task directly",
  build: "Work on the task directly",
  plan: "Read and propose a plan before changing anything",
};
