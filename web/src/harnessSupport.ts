// The "Harness support" table's data (components/HarnessSupport.tsx): features × installed
// harnesses from the runner's capability matrix, and how each level is labelled.

import { HARNESSES, type CapabilityLevel, type HarnessCapabilities, type HarnessId, type SlotId } from "./shared/protocol";

/** The features, in the order the table lists them. */
export const SLOT_LABEL: Record<SlotId, string> = {
  mcp: "MCP servers",
  skills: "Skills",
  memory: "Shared memory",
  goal: "Goals (/goal)",
  plan: "Plan review",
  todos: "Todo list",
  ask_user: "Questions to you",
  schedules: "Loops and schedules",
  fork: "Fork from a message",
  compact: "Compact (/compact)",
  commands: "Custom commands",
  agents: "Subagents",
  hooks: "Hooks",
  env: "Environment",
};

export const LEVEL: Record<CapabilityLevel, { label: string; color: "green" | "blue" | "gray" }> = {
  native: { label: "Native", color: "green" },
  emulated: { label: "Tether", color: "blue" },
  unsupported: { label: "Not available", color: "gray" },
};

export interface SupportRow extends Record<string, unknown> {
  slot: SlotId;
}

/** Rows (features) × the harnesses this runner has, in HARNESSES order. */
export function supportRows(caps: HarnessCapabilities, installed: HarnessId[]): { harnesses: HarnessId[]; rows: SupportRow[] } {
  const harnesses = HARNESSES.map((h) => h.id).filter((h) => installed.includes(h) && caps[h]);
  const slots = (Object.keys(SLOT_LABEL) as SlotId[]).filter((s) => harnesses.some((h) => caps[h]?.[s]));
  return { harnesses, rows: slots.map((slot) => ({ slot })) };
}
