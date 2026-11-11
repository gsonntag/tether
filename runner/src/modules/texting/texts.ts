// Every text Tether sends to the person's phone, in one place. The style rule, from the person
// ("max 1 sentence like a coworker texting u and don't tell me it works or whatever idc"; "text like
// a human"):
// - Text like a human: short and casual, at most one sentence, like a coworker texting.
// - Only what's notable or what needs the person (a decision, a failure, where to answer).
// - Never say that something works, passed or was verified.
// - Nothing to add: just "ok" (OK below), or better, nothing at all.
// - No acknowledgments after passing a reply on to a session ("Sent", "→ my-app", "Got it, the
//   session is doing X"): the session answers for itself. A forwarded reply sends no text back;
//   only a failure to forward does.
// - A text is just its session's number and the message ("[6] ok"): no folder, no agent label.
// - The session's link in Tether goes along at most every LINK_EVERY_MS (index.ts) per session, and
//   never on the back-and-forth of a texted conversation.
// What the agent wants or says (a command, a question's options, its answer) is carried as it is
// (describe.ts): that's the agent's text, not Tether's. A picker's numbered rows are the other
// exception to one sentence: a list under its question.
// casualText() is the check; texting.test.ts runs it over every text here.

/** Words that report that something works or passed: not for a text. */
const CONFIRMS = /\b(works?|worked|working|pass(ed|es|ing)?|verified|succeed(ed|s)?|success(ful(ly)?)?|all good|green)\b/i;

/** Acknowledgments of a forward: the session's own reply says more. */
const ACKS = /^(→|sent\b|got it\b|forwarded\b|delivered\b|passed (it )?on\b|on it\b)/i;

/** Whether `text` (without its "[n] " stamp) keeps the rule: one casual sentence, no "it works", no ack. */
export function casualText(text: string): boolean {
  if (ACKS.test(text.trim())) return false;
  const body = text.split("\n")[0]!.replace(/^\[\d+\] /, "");
  if (CONFIRMS.test(body)) return false;
  // One sentence: no sentence end before the last one.
  return !/[.!?](\s+)\S/.test(body.replace(/[.!?]+$/, "").replace(/\b(e\.g|i\.e|etc)\./gi, ""));
}

/** The words of a sentence without its final full stop. */
const bare = (s: string) => s.trim().replace(/\.+$/, "");

/** When a text must answer and there's nothing to add. */
export const OK = "ok";

export const TEXTS = {
  /** texting's own test, from settings */
  test: "Hey, it's Tether, reply here to talk to your sessions.",
  attention: (agent: string) => `${agent} needs you in the terminal, reply here and I'll type it in.`,
  failed: (agent: string, kind: string) => `${agent} stopped: ${kind}.`,
  /** an error's first line only: a failure is worth a text, its essay isn't */
  couldNotSend: (tag: string, error: string) => `Couldn't send to ${tag}: ${bare(error.split("\n")[0]!.split(/(?<=[.!?])\s/)[0]!)}.`,
  nothingOpen: "Nothing's waiting on a reply, message a session from Tether.",
  /** a picker's question, the rows go under it */
  which: "Which session, by number?",
  notWaiting: (n: number) => `[${n}] isn't waiting on a reply, which one did you mean?`,
  whatToSend: (n: number) => `What should I send to [${n}]?`,
};
