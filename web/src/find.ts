import type { Msg, Part } from "./shared/protocol";

/** Shorter terms match nearly everything: the bar waits for this many characters. */
export const MIN_TERM = 2;

/**
 * The text of a message as the find bar searches it: what a reader could see in the transcript
 * (text, thinking, a tool's name, command, path and output, a plan, a notice's title). Built once
 * per message object: the store replaces a message's object whenever it changes.
 */
export function messageText(m: Msg): string {
  return entry(m).text;
}

const cache = new WeakMap<Msg, { text: string; lower: string }>();
function entry(m: Msg) {
  let e = cache.get(m);
  if (!e) {
    const text = buildText(m);
    e = { text, lower: text.toLowerCase() };
    cache.set(m, e);
  }
  return e;
}

function buildText(m: Msg): string {
  const out: string[] = [];
  if (m.title) out.push(m.title);
  for (const p of m.parts) out.push(partText(p));
  if (m.error && m.error !== "aborted") out.push(m.error);
  return out.join("\n");
}

function partText(p: Part): string {
  switch (p.type) {
    case "text":
    case "thinking":
    case "plan":
      return p.text;
    case "tool":
      return [p.name, p.command, p.path, typeof p.input === "string" ? p.input : p.input == null ? "" : JSON.stringify(p.input), p.output, p.userRun?.output]
        .filter((s): s is string => !!s)
        .join("\n");
    case "skill":
      return `/${p.name}\n${p.content}`;
    case "file":
      return p.name;
    case "image":
      return "";
  }
}

/** How many times `needle` (already lower-case) occurs in `lower`, without overlaps. */
export function countIn(lower: string, needle: string): number {
  let n = 0;
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Indices of the messages whose text contains `term` (case-insensitive substring), in order. */
export function findMessageIndices(messages: Msg[], term: string): number[] {
  return findMatches(messages, term).indices;
}

/** The matching messages and how many occurrences they hold in all: the bar's "of m". */
export function findMatches(messages: Msg[], term: string): { indices: number[]; total: number } {
  const needle = term.toLowerCase();
  const indices: number[] = [];
  let total = 0;
  if (!needle) return { indices, total };
  for (let i = 0; i < messages.length; i++) {
    const n = countIn(entry(messages[i]!).lower, needle);
    if (n) {
      indices.push(i);
      total += n;
    }
  }
  return { indices, total };
}

/**
 * The next message to mount for the find bar: the latest matching message before `start` (the
 * first mounted one), or nothing when every match is on the page already. Walking back past the
 * first mounted match asks for this again, one matching message at a time.
 */
export function latestUnmounted(indices: number[], start: number): number | undefined {
  for (let k = indices.length - 1; k >= 0; k--) if (indices[k]! < start) return indices[k];
  return undefined;
}

/**
 * Which match a new term starts on: the last one that begins above the bottom edge of the view
 * (`tops` are the matches' top edges in document order), else the first one below; -1 for none.
 */
export function nearestIndex(tops: number[], bottom: number): number {
  if (!tops.length) return -1;
  let found = -1;
  for (let i = 0; i < tops.length; i++) if (tops[i]! < bottom) found = i;
  return found < 0 ? 0 : found;
}
