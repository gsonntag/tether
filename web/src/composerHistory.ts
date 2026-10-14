// The composer's ↑ history: what you typed in this session, without the user messages Tether
// itself sends (goal turns, plan approvals, hook feedback, a blocked command's result, briefs).
// Pure, so it's unit tested (composerHistory.test.ts).

import { splitAttachments } from "./shared/attachments";
import type { Msg } from "./shared/protocol";
import { REVIEW_PREFIX } from "./shared/review";
import { BRIEF_PREFIX } from "./msgTime";

const INJECTED = [
  "[Tether goal]", // runner/src/goal.ts GOAL_MARK
  "I approve the plan as it stands.", // runner/src/planReview.ts
  "Your blocked command was run by the user instead", // session.ts runBlocked
  "I changed my earlier message. It said:", // session.ts amendSteer
  BRIEF_PREFIX,
  REVIEW_PREFIX,
];

/** A user message Tether sent, not one you typed. */
export function isInjected(text: string): boolean {
  const t = text.trimStart();
  if (INJECTED.some((p) => t.startsWith(p))) return true;
  // runner/src/plan.ts IMPLEMENT_PROMPT, with or without approval notes
  if (t === "Implement the plan." || t.startsWith("Implement the plan.\n\nNotes for the work:")) return true;
  // session.ts hook feedback (PostToolUse, Stop…)
  return /^(PreToolUse|PostToolUse|Stop|UserPromptSubmit) hook feedback\b/.test(t);
}

/** Your messages, oldest first, as typed (without the attached-files block the runner adds). */
export function composerHistory(messages: Msg[]): string[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => splitAttachments(m.parts.filter((p) => p.type === "text").map((p) => p.text).join("")).text)
    .filter((message) => message.trim() && !isInjected(message));
}
