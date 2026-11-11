// What Tether adds to the system prompt of every session it runs (SPEC §9a), beside its MCP server:
// how to reply (Concise replies, a runner setting, on unless turned off) and how to text the person
// (text_person). The Home agent has its own rules and gets none of this.

import type { RunnerSettings } from "../../../../shared/protocol";
import { PEER_SERVER, TEXT_PERSON } from "../../../../shared/peers";

export const CONCISE_RULE =
  "End each turn with a short reply: 1–3 sentences with the outcome first, then a link (PR/URL) if there is one. Only add details (a short bullet list, at most ~5 bullets) when the person needs them to make a decision or something failed. No test counts, file lists, or recap of steps unless asked.";

export const TEXTING_RULE = `To text the person, use the ${TEXT_PERSON} tool (mcp__${PEER_SERVER}__${TEXT_PERSON}). Their reply comes back to this session as a message. Text only when the person asked you to or you're blocked on them; if Tether's Home agent started or drives this session, it texts the person for you: put news in your final reply instead.`;

/** The instructions for a session Tether runs, with the runner's settings as they are now. */
export function sessionInstructions(s: RunnerSettings): string {
  return [
    "This session runs in Tether: the person reads your replies in Tether's app, often on a phone.",
    ...(s.conciseReplies === false ? [] : [CONCISE_RULE]),
    TEXTING_RULE,
  ].join("\n\n");
}
