// Every text Tether sends to the person's phone, in one place. The style rule, from the person
// ("max 1 sentence like a coworker texting u and don't tell me it works or whatever idc"; "text like
// a human"):
// - Text like a human: short and casual, at most one sentence, like a coworker texting.
// - Only what's notable or what needs the person (a decision, a failure, where to answer).
// - Never say that something works, passed or was verified.
// - Nothing to add: just "ok" (OK below), or better, nothing at all.
// - No acknowledgments after passing a reply on to a session ("Sent", "→ my-app", "Got it, the
//   session is doing X"): the session answers for itself. A forwarded reply sends no text back,
//   just a ✅ reaction on it (index.ts READ); only a failure to forward sends a text.
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
  whatToSendHome: "What should I send to the Home agent?",
  /** a picker's last row: plain words can go to the Home agent */
  homeRow: "h: the Home agent",
  /** "home: ..." on a runner without a Home agent */
  noHome: "The Home agent isn't running on this runner.",
  /** the Home agent's chat failed on something the person texted */
  homeFailed: (kind: string) => `Home agent stopped: ${kind}.`,
  /** a file the person sent that didn't come along (too big, a host Tether doesn't take, or it didn't download) */
  fileSkipped: (name: string) => `Couldn't take ${name}, it's too big or it didn't download.`,
  /** files sent with a message that went nowhere (a reply asking which session, the picker's hold expiring, a restart) */
  filesNotSent: "Your file didn't go anywhere, send it again with the session's number.",
  /** files sent with an answer to a request, where the session can't take them after it: the request was answered, the files weren't passed on */
  filesWithAnswer: (n: number) => `[${n}] I answered the request but your file didn't go, send it again after.`,
  /** a voice note, a contact card, a poll: nothing Tether can pass on */
  onlyTextAndFiles: "Only text and files get through, so I left the rest out.",
  /** sending failed, and the files with it didn't go either */
  couldNotSendWithFile: (tag: string, error: string) => `Couldn't send to ${tag} (nor your file): ${bare(error.split("\n")[0]!.split(/(?<=[.!?])\s/)[0]!)}.`,
  /** "h1 …" for a home that isn't open */
  noSuchHome: (label: string, list: string) => `There's no ${label}, your homes are ${list}.`,
  /** just "h1" aimed at a home that was deleted since */
  homeGone: (list: string) => `That home was deleted, your homes are ${list}.`,
  /** a text to a home that was deleted since: sent to h instead */
  homeGoneSentToH: "That home was deleted, so I sent it to h.",
  /** just "h1": what to send there */
  whatToSendTo: (label: string) => `What should I send to ${label}?`,
  /** "hn" with nothing to send: the new home's name */
  homeStarted: (label: string) => `Started ${label}, text ${label} to reach it.`,
  /** "hd1": done, and what's left */
  homeDeleted: (label: string, list: string) => `Deleted ${label}, your homes are ${list}.`,
  /** "hn" with MAX_EXTRA_HOMES open already */
  homesFull: (list: string) => `You have ${list} already, delete one with hd and its number first.`,
  /** "hd0" or the like */
  cantDeletePrimary: "h is your main home, so it can't be deleted.",
  /** a reply to a request text after the request closed: it isn't sent anywhere (text again to message the session) */
  alreadyAnswered: (n: number) => `[${n}] That was already answered, so I didn't send your reply anywhere.`,
};
