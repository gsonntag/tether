// What Tether adds to the system prompt of every session it runs (SPEC §9a), beside its MCP server:
// how to reply (Concise replies, a runner setting, on unless turned off) and how to text the person
// (text_person), and to archive the sessions it starts once done with them (tether_archive).

import type { RunnerSettings } from "../../../../shared/protocol";
import { PEER_SERVER, TEXT_PERSON } from "../../../../shared/peers";

export const CONCISE_RULE =
  "End each turn with a short reply: 1–3 sentences with the outcome first, then a link (PR/URL) if there is one. Only add details (a short bullet list, at most ~5 bullets) when the person needs them to make a decision or something failed. No test counts, file lists, or recap of steps unless asked.";

export const TEXTING_RULE = `To text the person, use the ${TEXT_PERSON} tool (mcp__${PEER_SERVER}__${TEXT_PERSON}). Their reply comes back to this session as a message. It can send an image after the text (image: an absolute path to a .png, .jpg, .gif, .webp or .heic). Text only when the person asked you to or you're blocked on them. It works only when the person ticked "Session can text me" on this session; otherwise it returns an error: put it in your reply instead.`;

export const STARTED_RULE = "A session you start with tether_start stays in the person's sidebar until you archive it: once you're done with it (its work reported, nothing more to ask), archive it with tether_archive.";

/** The instructions for a session Tether runs, with the runner's settings as they are now. */
export function sessionInstructions(s: RunnerSettings): string {
  return [
    "This session runs in Tether: the person reads your replies in Tether's app, often on a phone.",
    ...(s.conciseReplies === false ? [] : [CONCISE_RULE]),
    TEXTING_RULE,
    "Use the subscription by default when available for tether_start. You must confirm API-key billing with the user before starting a session. This includes replacement and fallback sessions. Get the user’s confirmation for each automatic fallback billing source and its priority before enabling it. Tether sets up each billing source itself (keys and Azure deployments in its Settings), so never edit an agent's config or set API-key environment variables for it; tether_models lists each source's models.",
    STARTED_RULE,
  ].join("\n\n");
}
