// Hooks on the Memory & Skills page (components/Hooks.tsx): labels and the JSON you edit.

import type { HookView } from "./shared/protocol";

const EVENT_LABEL: Record<HookView["event"], string> = {
  PreToolUse: "Before",
  PostToolUse: "After",
  Stop: "When a turn ends",
  UserPromptSubmit: "Before your message goes out",
};

/** "Before Bash", "After every tool", "When a turn ends". */
export function hookLabel(h: Pick<HookView, "event" | "matcher">): string {
  if (h.event !== "PreToolUse" && h.event !== "PostToolUse") return EVENT_LABEL[h.event];
  const m = h.matcher && h.matcher !== "*" ? h.matcher.replace(/\|/g, ", ") : "every tool";
  return `${EVENT_LABEL[h.event]} ${m}`;
}

/** The editable JSON: one entry in Claude Code's shape, plus its event. */
export function hookJson(h: Pick<HookView, "event" | "matcher" | "hooks">): string {
  const tool = h.event === "PreToolUse" || h.event === "PostToolUse";
  return JSON.stringify({ event: h.event, ...(tool ? { matcher: h.matcher } : {}), hooks: h.hooks }, null, 2);
}
