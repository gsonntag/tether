// Size limits on the wire. A frame must stay well under the relay's 16 MB payload limit, or a
// socket would be closed and reopened forever on the same snapshot. Big part contents are cut
// short (with `truncated` set; `fullPart` fetches them whole) and snapshots and history pages are
// cut by bytes as well as by count.

import type { Msg, Part } from "./transcript";

/** Text, thinking and tool output longer than this are cut to it. */
export const PART_TEXT_MAX = 64 * 1024;
/** Inline images whose base64 is longer than this travel without their data. */
export const IMAGE_DATA_MAX = 1024 * 1024;
/** A snapshot, reset or history page carries at most about this many bytes of messages. */
export const PAGE_BYTES_MAX = 2 * 1024 * 1024;

const cut = (text: string) => text.slice(0, PART_TEXT_MAX);

/** The part as it travels in a snapshot or event: big content cut short, marked `truncated`. */
export function capPart(p: Part): Part {
  switch (p.type) {
    case "text":
    case "thinking":
      return p.text.length > PART_TEXT_MAX ? { ...p, text: cut(p.text), truncated: p.text.length } : p;
    case "image":
      return p.data.length > IMAGE_DATA_MAX ? { ...p, data: "", truncated: p.data.length } : p;
    case "tool":
      return p.output && p.output.length > PART_TEXT_MAX ? { ...p, output: cut(p.output), truncated: p.output.length } : p;
  }
}

export function capMessage(m: Msg): Msg {
  return m.parts.some((p) => capPart(p) !== p) ? { ...m, parts: m.parts.map(capPart) } : m;
}

/**
 * The newest messages that fit both `limit` and PAGE_BYTES_MAX (always at least one), capped,
 * oldest first. `hasOlder` says whether anything before them was left out.
 */
export function newestPage(messages: Msg[], limit: number, maxBytes = PAGE_BYTES_MAX): { messages: Msg[]; hasOlder: boolean } {
  const out: Msg[] = [];
  let bytes = 0;
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = capMessage(messages[i]!);
    const size = JSON.stringify(m).length;
    if (out.length > 0 && bytes + size > maxBytes) break;
    out.push(m);
    bytes += size;
  }
  return { messages: out.reverse(), hasOlder: out.length < messages.length };
}
