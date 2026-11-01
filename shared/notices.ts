// The same error, over and over (a session that can't start, retried), is one row in the chat.
// The runner drops a repeat right after itself; `collapseErrors` is the reading side, for repeats
// already kept in notices.json and for a failed message sitting between two of them.

import type { Msg } from "./transcript";

/** The most a kept notice holds (notices.ts): longer ones compare by this much. */
const COMPARED = 2000;

/** What an error notice says, whichever way it was said; undefined for anything else. */
function errorText(m: Msg): string | undefined {
  if (m.role !== "notice" || m.level !== "error") return undefined;
  const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ");
  return text.replace(/^Couldn't start [^:]+: /, "").slice(0, COMPARED);
}

/** `m` says the error `last` says, with nothing between them. */
export function repeatsError(last: Msg | undefined, m: Msg): boolean {
  const text = errorText(m);
  return text !== undefined && !!last && errorText(last) === text;
}

/** A message you typed. Nothing but a failure answered it if an error follows. */
const typed = (m: Msg) => m.role === "user" && !m.origin && !m.shell && !m.localCommand && !m.relay;
/** An agent's reply that hasn't said anything. */
const blank = (m: Msg) => m.role === "assistant" && !m.parts.length && !m.error;

export interface CollapsedRows {
  messages: Msg[];
  /** a hidden repeat's id, and the id of the row it repeats */
  hidden: Map<string, string>;
  /** messages you sent that a hidden repeat answered: nothing else in the chat says they failed */
  failed: Set<string>;
}

/**
 * The rows to show: an error notice the same as the last one is hidden, also across messages you
 * sent meanwhile (they failed, and say so: `failed`). Any other row ends the run. The first row of a
 * run stays, so rows already on screen keep their ids.
 */
export function collapseErrors(list: Msg[]): CollapsedRows {
  const out: CollapsedRows = { messages: list, hidden: new Map(), failed: new Set() };
  let run: { id: string; text: string } | undefined;
  let sent: Msg[] = [];
  list.forEach((m, i) => {
    const text = errorText(m);
    if (text !== undefined && run?.text === text) {
      if (out.messages === list) out.messages = list.slice(0, i);
      out.hidden.set(m.id, run.id);
      for (const u of sent) out.failed.add(u.id);
      sent = [];
      return;
    }
    if (out.messages !== list) out.messages.push(m);
    if (text !== undefined) {
      run = { id: m.id, text };
      sent = [];
    } else if (typed(m)) sent.push(m);
    else if (!blank(m)) run = undefined;
  });
  return out;
}
