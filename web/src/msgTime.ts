// When each transcript message was written: a short label relative to today ("3:42 PM",
// "Yesterday 3:42 PM", "Oct 9, 3:42 PM", "Oct 9, 2025") and the full time for its tooltip. Pure, so
// it's unit tested with a fixed "now" (msgTime.test.ts).

import type { Msg } from "./shared/protocol";

const startOfDay = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** The local calendar day `t` falls on, as a number (changes at local midnight). */
export const dayKey = (t: number) => startOfDay(t);

const formats = new Map<string, Intl.DateTimeFormat>();
function fmt(locale: string | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ""}|${JSON.stringify(opts)}`;
  let f = formats.get(key);
  if (!f) formats.set(key, (f = new Intl.DateTimeFormat(locale, opts)));
  return f;
}

const TIME: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

/** "Yesterday", in the locale's own words. */
function yesterday(locale?: string): string {
  const word = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day");
  return word.charAt(0).toLocaleUpperCase(locale) + word.slice(1);
}

/** today "3:42 PM" · yesterday "Yesterday 3:42 PM" · this year "Oct 9, 3:42 PM" · older "Oct 9, 2025" */
export function formatMsgTime(ts: number, now: number, locale?: string): string {
  const day = startOfDay(ts);
  const today = startOfDay(now);
  if (day === today) return fmt(locale, TIME).format(ts);
  const prev = new Date(today);
  prev.setDate(prev.getDate() - 1);
  if (day === prev.getTime()) return `${yesterday(locale)} ${fmt(locale, TIME).format(ts)}`;
  if (new Date(ts).getFullYear() === new Date(now).getFullYear()) return fmt(locale, { month: "short", day: "numeric", ...TIME }).format(ts);
  return fmt(locale, { year: "numeric", month: "short", day: "numeric" }).format(ts);
}

/** The full date and time, to the second: "Friday, October 9, 2026 at 3:42:05 PM". */
export function fullMsgTime(ts: number, locale?: string): string {
  return fmt(locale, { dateStyle: "full", timeStyle: "medium" }).format(ts);
}

export const BRIEF_PREFIX = "You are taking over an in-progress coding session";

/** Who a message shows as, for grouping times; undefined: it shows no time of its own. */
function speaker(m: Msg): Msg["role"] | undefined {
  if (!m.ts) return undefined; // unknown (an ACP agent's replayed history)
  if (m.role !== "user") return m.role;
  // A user message carrying only tool results shows as the agent's tool cards; a handoff brief as a card.
  const text = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
  if (text.trimStart().startsWith(BRIEF_PREFIX)) return undefined;
  return text.trim() || m.parts.some((p) => p.type === "skill" || p.type === "file" || p.type === "image") ? "user" : undefined;
}

/** Messages within this long of the last shown time, from the same side, don't repeat it. */
export const GROUP_MS = 60_000;

/**
 * The messages that show their time: the first of each run from the same side (you, the agent, a
 * notice), and again once a minute has passed since the last time shown in the run.
 */
export function timedMessages(messages: Msg[]): Set<string> {
  const out = new Set<string>();
  let side: Msg["role"] | undefined;
  let shownAt = 0;
  for (const m of messages) {
    const who = speaker(m);
    if (!who) continue;
    if (who !== side || Math.abs(m.ts - shownAt) >= GROUP_MS || dayKey(m.ts) !== dayKey(shownAt)) {
      out.add(m.id);
      side = who;
      shownAt = m.ts;
    }
  }
  return out;
}
