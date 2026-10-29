// A session's transcript as the runner holds it while the session is open: the whole message list
// (read from the harness's store, then grown by live events), indexed by id. Browsers only ever
// get pages of it (shared/limits.ts newestPage), and events refer to messages by id.

import { newestPage } from "../../../shared/limits";
import type { Msg, Part, SessionEvent, ToolPart } from "../../../shared/transcript";
import { patchTool } from "../../../shared/window";
import type { TranscriptEvent } from "./adapter";

export class Transcript {
  private list: Msg[] = [];
  private index = new Map<string, number>();

  constructor(messages: Msg[] = []) {
    this.replace(messages);
  }

  get messages(): readonly Msg[] {
    return this.list;
  }

  get length() {
    return this.list.length;
  }

  get(id: string): Msg | undefined {
    const i = this.index.get(id);
    return i === undefined ? undefined : this.list[i];
  }

  replace(messages: Msg[]) {
    this.list = [...messages];
    this.reindex();
  }

  /**
   * Applies a transcript event. Returns the event as it should go out (a `msg` gets `isNew` when it
   * appends), or null when it changed nothing a browser could see (a delta for an unknown message).
   */
  apply(e: TranscriptEvent): SessionEvent | null {
    switch (e.type) {
      case "reset":
        this.replace(e.messages);
        return e;
      case "msg": {
        const i = this.index.get(e.msg.id);
        if (i !== undefined) {
          this.list[i] = e.msg;
          return { type: "msg", msg: e.msg };
        }
        this.index.set(e.msg.id, this.list.length);
        this.list.push(e.msg);
        return { type: "msg", msg: e.msg, isNew: true };
      }
      case "delta": {
        const m = this.get(e.msgId);
        const p = m?.parts[e.part];
        if (!m || !p) return null;
        if (p.type === "tool") this.set(m, e.part, { ...p, output: (p.output ?? "") + e.text });
        else if (p.type === "text" || p.type === "thinking") this.set(m, e.part, { ...p, text: p.text + e.text });
        else return null;
        return e;
      }
      case "tool": {
        const m = this.get(e.msgId);
        const i = m?.parts.findIndex((p) => p.type === "tool" && p.id === e.toolId) ?? -1;
        if (!m || i < 0) return null;
        this.set(m, i, patchTool(m.parts[i] as ToolPart, e.patch));
        return e;
      }
    }
  }

  /** The newest page, capped (shared/limits.ts). */
  newest(limit: number) {
    return newestPage(this.list as Msg[], limit);
  }

  /** Up to `limit` messages before the one with id `before` (capped like a snapshot). */
  before(before: string, limit: number): { messages: Msg[]; hasOlder: boolean } {
    const i = this.index.get(before);
    if (i === undefined) throw new Error("That message is no longer in the transcript. Reopen the session.");
    return newestPage(this.list.slice(0, i), limit);
  }

  /** Where a message and a tool call is: the message that holds tool call `toolId`. */
  findTool(toolId: string): { msg: Msg; index: number } | undefined {
    for (let k = this.list.length - 1; k >= 0; k--) {
      const msg = this.list[k]!;
      const index = msg.parts.findIndex((p) => p.type === "tool" && p.id === toolId);
      if (index >= 0) return { msg, index };
    }
    return undefined;
  }

  private set(m: Msg, partIndex: number, part: Part) {
    const parts = [...m.parts];
    parts[partIndex] = part;
    this.list[this.index.get(m.id)!] = { ...m, parts };
  }

  private reindex() {
    this.index.clear();
    this.list.forEach((m, i) => this.index.set(m.id, i));
  }
}

/** More changes than this from one store change: one reset instead of a message each. */
export const DIFF_RESET_OVER = 50;

/**
 * A message as the store and the live stream both describe it: without its time and streaming
 * flag (live and stored differ there), thinking text (Claude Code stores it empty), and with
 * keys in a fixed order.
 */
function canonical(m: Msg): string {
  const { ts: _t, streaming: _s, ...rest } = m;
  const parts = m.parts.map((p) => (p.type === "thinking" ? { ...p, text: "" } : p));
  return stable({ ...rest, parts });
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .filter((k) => (v as any)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/**
 * The events that turn transcript `from` into `to` (a stored session whose file changed): new
 * messages appended at the end, changed ones replaced in place. Anything else (messages removed or
 * reordered: a rewind) is a reset, and so is a change touching more than DIFF_RESET_OVER messages
 * (a session that just went from live to stored would otherwise resend every message).
 */
export function diffTranscripts(from: readonly Msg[], to: Msg[]): TranscriptEvent[] {
  const reset: TranscriptEvent[] = [{ type: "reset", messages: to, hasOlder: false }];
  const pos = new Map(to.map((m, i) => [m.id, i]));
  // Every old message must still be there, at the same place.
  for (let i = 0; i < from.length; i++) if (pos.get(from[i]!.id) !== i) return reset;
  const out: TranscriptEvent[] = [];
  for (let i = 0; i < from.length; i++) if (canonical(from[i]!) !== canonical(to[i]!)) out.push({ type: "msg", msg: to[i]! });
  for (let i = from.length; i < to.length; i++) out.push({ type: "msg", msg: to[i]! });
  return out.length > DIFF_RESET_OVER ? reset : out;
}
