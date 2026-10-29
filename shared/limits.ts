// Size limits on the wire, all in UTF-8 bytes (what the socket carries), never UTF-16 characters.
// Every frame must stay well under the relay's limits (16 MB payload, a send buffer closed past
// 12 MB), or a socket would be closed and reopened forever on the same snapshot. So:
//   - part content is cut short (text, thinking and tool output to 64 KB, images over 1 MB
//     travel without data) and tool and request inputs are trimmed, all marked;
//   - a message keeps its parts up to 1 MB and marks the rest `partsOmitted`;
//   - snapshot, reset and history pages are cut at 2 MB as well as by count;
//   - `fullPart` returns any part whole, in slices of about 1 MB;
//   - last resort, `guardFrame` turns any frame over 4 MB into an error answer or a `resync`.
// The runner applies capEvent / newestPage to everything it sends.

import type { RunnerToServer } from "./protocol";
import type { LiveState, Msg, Part, QueuedMessage, Request, SessionEvent, ToolPart } from "./transcript";

/** Text, thinking and tool output longer than this are cut to it. */
export const PART_TEXT_MAX = 64 * 1024;
/** Inline images whose base64 is longer than this travel without their data. */
export const IMAGE_DATA_MAX = 1024 * 1024;
/** A string inside a tool or request input longer than this is trimmed. */
export const INPUT_STRING_MAX = 8 * 1024;
/** A tool or request input whose JSON is still longer than this travels as a preview. */
export const INPUT_JSON_MAX = 64 * 1024;
/** A message carries parts up to about this many bytes; the rest are `partsOmitted`. */
export const MESSAGE_BYTES_MAX = 1024 * 1024;
/** A snapshot, reset or history page carries at most about this many bytes of messages. */
export const PAGE_BYTES_MAX = 2 * 1024 * 1024;
/** One `fullPart` answer carries at most this much of the part's JSON. */
export const PART_CHUNK_MAX = 1024 * 1024;
/**
 * No frame the runner sends is larger than this. A third of the relay's send-buffer limit
 * (server/src/app.ts BACKPRESSURE_LIMIT), so one big frame never by itself closes a slow socket.
 */
export const FRAME_BYTES_MAX = 4 * 1024 * 1024;

/** UTF-8 length of a string, without encoding it. */
export function utf8Length(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) n += 1;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      // A surrogate pair: 2 UTF-16 units, 4 bytes.
      n += 2;
      i++;
    } else n += 2;
  }
  return n;
}

/** The longest prefix of `s` that fits in `max` UTF-8 bytes (never splitting a surrogate pair). */
export function cutBytes(s: string, max: number): string {
  if (s.length * 3 <= max || utf8Length(s) <= max) return s;
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const pair = c >= 0xd800 && c <= 0xdbff && i + 1 < s.length;
    const w = c < 0x80 ? 1 : c < 0x800 ? 2 : pair ? 4 : 3;
    if (bytes + w > max) return s.slice(0, i);
    bytes += w;
    if (pair) i++;
  }
  return s;
}

const cut = (text: string) => cutBytes(text, PART_TEXT_MAX);
const over = (text: string, max: number) => text.length > max / 3 && utf8Length(text) > max;
/** Bytes of a value's JSON. */
const size = (v: unknown) => utf8Length(JSON.stringify(v) ?? "");

/**
 * An input with its long strings and arrays trimmed, keeping its shape so the UI can still show
 * a command or a path; if that is still too big, a JSON preview instead. `truncated` says whether
 * anything was cut.
 */
export function capInput(input: unknown): { value: unknown; truncated: boolean } {
  let truncated = false;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      if (!over(v, INPUT_STRING_MAX)) return v;
      truncated = true;
      return `${cutBytes(v, INPUT_STRING_MAX)}…`;
    }
    if (typeof v !== "object" || v === null) return v;
    if (depth > 20) return ((truncated = true), "…");
    if (Array.isArray(v)) {
      if (v.length > 200) truncated = true;
      return v.slice(0, 200).map((x) => walk(x, depth + 1));
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, depth + 1)]));
  };
  const value = walk(input, 0);
  const json = JSON.stringify(value) ?? "";
  if (over(json, INPUT_JSON_MAX)) return { value: { preview: cutBytes(json, INPUT_JSON_MAX) }, truncated: true };
  return { value: truncated ? value : input, truncated };
}

function capTool<T extends Partial<ToolPart>>(p: T): T {
  let out = p;
  if (p.output && over(p.output, PART_TEXT_MAX)) out = { ...out, output: cut(p.output), truncated: p.output.length };
  if (p.input !== undefined) {
    const c = capInput(p.input);
    if (c.truncated) out = { ...out, input: c.value, inputTruncated: true };
  }
  return out;
}

/**
 * A tool patch as it travels. Unlike a whole part, a patch is spread over a part that may carry
 * flags from an earlier, bigger value: so a patch that sets `output` always says whether it is cut
 * (`truncated`, 0 when whole) and one that sets `input` always says `inputTruncated`.
 */
export function capToolPatch(p: Partial<ToolPart>): Partial<ToolPart> {
  const out = capTool(p);
  const flags: Partial<ToolPart> = {};
  if (p.output !== undefined && out.truncated === undefined) flags.truncated = 0;
  if (p.input !== undefined && out.inputTruncated === undefined) flags.inputTruncated = false;
  return Object.keys(flags).length ? { ...out, ...flags } : out;
}

/** The part as it travels: big content cut short, marked. */
export function capPart(p: Part): Part {
  switch (p.type) {
    case "text":
    case "thinking":
      return over(p.text, PART_TEXT_MAX) ? { ...p, text: cut(p.text), truncated: p.text.length } : p;
    case "image":
      return p.data.length > IMAGE_DATA_MAX ? { ...p, data: "", truncated: p.data.length } : p;
    case "tool":
      return capTool(p);
  }
}

/** Every part capped, and parts beyond MESSAGE_BYTES_MAX left out (always at least one kept). */
export function capMessage(m: Msg): Msg {
  const parts = m.parts.map(capPart);
  let bytes = 0;
  let keep = 0;
  for (const p of parts) {
    const s = size(p);
    if (keep > 0 && bytes + s > MESSAGE_BYTES_MAX) break;
    bytes += s;
    keep++;
  }
  const omitted = parts.length - keep;
  if (!omitted && parts.every((p, i) => p === m.parts[i])) return m;
  return omitted ? { ...m, parts: parts.slice(0, keep), partsOmitted: omitted } : { ...m, parts };
}

export function capRequest(r: Request): Request {
  let out = r;
  if (r.plan !== undefined && over(r.plan, PART_TEXT_MAX)) out = { ...out, plan: cut(r.plan) };
  if (r.input === undefined) return out;
  const c = capInput(r.input);
  return c.truncated ? { ...out, input: c.value, inputTruncated: true } : out;
}

/** A waiting message as it travels: long text cut (the runner keeps it whole), marked. */
/** Bytes a string takes inside a JSON frame (escapes included: a control character is 6). */
export function jsonBytes(s: string): number {
  return utf8Length(JSON.stringify(s)) - 2;
}

/** The longest prefix of `s` whose JSON form fits in `max` bytes. */
function cutJson(s: string, max: number): string {
  let out = cutBytes(s, max);
  while (out && jsonBytes(out) > max) out = cutBytes(out, Math.max(0, max - (jsonBytes(out) - max) - 1));
  return out;
}

/** C0 control characters (but tab and newlines) and DEL: never kept in queued text. */
export const stripControls = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");

/** A waiting message as it travels: long text cut (the runner keeps it whole), marked. */
export function capQueued(m: QueuedMessage, max = QUEUED_TEXT_WIRE): QueuedMessage {
  return jsonBytes(m.text) > max ? { ...m, text: cutJson(m.text, max), truncated: m.truncated ?? utf8Length(m.text) } : m;
}

/**
 * A queue as it travels. Each text is cut to QUEUED_TEXT_WIRE; if the whole is still big (a queue
 * saved before the caps), cut further, so a session's state always fits a frame and it always opens.
 */
export function capQueue(q: QueuedMessage[]): QueuedMessage[] {
  let out = q.map((m) => capQueued(m));
  if (out.reduce((n, m) => n + jsonBytes(m.text), 0) > QUEUE_BYTES_MAX) out = out.map((m) => capQueued(m, 1024));
  return out;
}

export function capState(s: LiveState): LiveState {
  return { ...s, requests: s.requests.map(capRequest), queue: capQueue(s.queue) };
}

/** A session event as it travels. */
export function capEvent(e: SessionEvent): SessionEvent {
  switch (e.type) {
    case "msg": {
      const msg = capMessage(e.msg);
      return msg === e.msg ? e : { ...e, msg };
    }
    case "reset": {
      const page = newestPage(e.messages, e.messages.length);
      return { type: "reset", messages: page.messages, hasOlder: e.hasOlder || page.hasOlder };
    }
    case "tool":
      return { ...e, patch: capToolPatch(e.patch) };
    case "delta":
      // A delta is a few tokens; one this big is a bug upstream, and is cut like a part.
      return over(e.text, PART_TEXT_MAX) ? { ...e, text: cut(e.text) } : e;
    case "state": {
      if (!e.state.requests && !e.state.queue) return e;
      const st = { ...e.state };
      if (st.requests) st.requests = st.requests.map(capRequest);
      if (st.queue) st.queue = capQueue(st.queue);
      return { ...e, state: st };
    }
    case "resync":
      return e;
  }
}

/**
 * The newest messages that fit both `limit` and `maxBytes` (always at least one), capped, oldest
 * first. `hasOlder` says whether anything before them was left out.
 */
export function newestPage(messages: Msg[], limit: number, maxBytes = PAGE_BYTES_MAX): { messages: Msg[]; hasOlder: boolean } {
  const out: Msg[] = [];
  let bytes = 0;
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = capMessage(messages[i]!);
    const s = size(m);
    if (out.length > 0 && bytes + s > maxBytes) break;
    out.push(m);
    bytes += s;
  }
  return { messages: out.reverse(), hasOlder: out.length < messages.length };
}

// ---------- fullPart ----------

export interface PartChunk {
  /** a slice of the part's JSON (offsets count UTF-16 units of that JSON) */
  chunk: string;
  offset: number;
  /** the JSON's full length */
  total: number;
  /** a hash of the whole JSON: a part that changes between slices (a tool still running) is noticed */
  version: string;
  done: boolean;
}

/** FNV-1a over UTF-16 units: cheap, and enough to tell two versions of one part apart. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ":" + s.length.toString(36);
}

/**
 * The slice of a part's JSON starting at `offset` (the runner's side of `fullPart`). Slices are cut
 * at PART_CHUNK_MAX UTF-16 units, at most 3 MB of UTF-8, so an answer stays under the frame limit.
 */
export function partChunk(part: Part, offset = 0): PartChunk {
  const json = JSON.stringify(part);
  const start = Math.max(0, Math.min(offset | 0, json.length));
  let end = Math.min(json.length, start + PART_CHUNK_MAX);
  // Never end a slice between the halves of a surrogate pair.
  const c = json.charCodeAt(end - 1);
  if (end < json.length && c >= 0xd800 && c <= 0xdbff) end--;
  const chunk = json.slice(start, end);
  return { chunk, offset: start, total: json.length, version: hashString(json), done: end >= json.length };
}

/**
 * Fetches every slice through `get` and returns the whole part (the browser's side). Every slice
 * must come from the same version of the part; one that changed midway fails.
 */
export async function fetchFullPart(get: (offset: number) => Promise<PartChunk>): Promise<Part> {
  let json = "";
  let first: PartChunk | undefined;
  for (;;) {
    const c = await get(json.length);
    first ??= c;
    if (c.offset !== json.length || c.total !== first.total || c.version !== first.version) throw new Error("The part changed while loading.");
    json += c.chunk;
    if (c.done) {
      if (json.length !== c.total) throw new Error("The part stopped short.");
      return JSON.parse(json);
    }
    if (!c.chunk) throw new Error("The part stopped short.");
  }
}

// ---------- last resort ----------

/**
 * The frame to send for `m` (null: send nothing). Anything over FRAME_BYTES_MAX that the caps
 * missed is replaced: a result by an error answer, an event by `resync` (same seq, so subscribers
 * refetch a capped snapshot). Other frames that big are dropped. `replaced` tells the caller to log.
 */
export function guardFrame(m: RunnerToServer): { frame: string | null; replaced: boolean } {
  const s = JSON.stringify(m);
  if (s.length * 3 <= FRAME_BYTES_MAX || utf8Length(s) <= FRAME_BYTES_MAX) return { frame: s, replaced: false };
  if (m.t === "result") return { frame: JSON.stringify({ t: "result", id: m.id, ok: false, error: "The answer was too large to send." } satisfies RunnerToServer), replaced: true };
  if (m.t === "event") return { frame: JSON.stringify({ t: "event", sessionId: m.sessionId, seq: m.seq, event: { type: "resync" } } satisfies RunnerToServer), replaced: true };
  return { frame: null, replaced: true };
}

// ---------- attachments and the queue (SPEC §9) ----------

/** One attached image, as uploaded (the browser downscales photos first, so this is generous). */
export const ATTACH_IMAGE_MAX = 10 * 1024 * 1024;
/** One attached file of any other type. */
export const ATTACH_FILE_MAX = 25 * 1024 * 1024;
/** Attachments on one message. */
export const ATTACH_MAX = 10;
/**
 * Raw bytes per `uploadAttachment` chunk: about 350 KB of base64 in one rpc frame, far below the
 * frame and send-buffer limits above, so an upload never crowds out a session's events.
 */
export const ATTACH_CHUNK = 256 * 1024;
/** Photos are scaled down in the browser to this long edge before they upload. */
export const ATTACH_IMAGE_EDGE = 2048;
/** A session's attachments on the runner, all together. */
export const ATTACH_SESSION_MAX = 2 * 1024 * 1024 * 1024;
/** Waiting messages per session. */
export const QUEUE_MAX = 50;
/**
 * All of a session's waiting messages together (UTF-8 bytes of their text): far under the frame
 * limit, so a session's state always travels and the session always opens.
 */
export const QUEUE_BYTES_MAX = 1024 * 1024;
/** A waiting message's text in a state frame; longer ones travel cut, marked `truncated`. */
export const QUEUED_TEXT_WIRE = 16 * 1024;
/** One message's text (sent, steered or queued). */
export const MESSAGE_TEXT_MAX = 200 * 1024;
