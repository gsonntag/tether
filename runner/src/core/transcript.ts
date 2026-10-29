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
        if (!m || !p || (p.type !== "text" && p.type !== "thinking")) return null;
        this.set(m, e.part, { ...p, text: p.text + e.text });
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

/**
 * The events that turn transcript `from` into `to` (a stored session whose file changed): new
 * messages appended at the end, changed ones replaced in place. Anything else (messages removed or
 * reordered: a rewind, a compaction) is a reset.
 */
export function diffTranscripts(from: readonly Msg[], to: Msg[]): TranscriptEvent[] {
  const pos = new Map(to.map((m, i) => [m.id, i]));
  // Every old message must still be there, at the same place.
  for (let i = 0; i < from.length; i++) if (pos.get(from[i]!.id) !== i) return [{ type: "reset", messages: to, hasOlder: false }];
  const out: TranscriptEvent[] = [];
  for (let i = 0; i < from.length; i++) if (JSON.stringify(from[i]) !== JSON.stringify(to[i])) out.push({ type: "msg", msg: to[i]! });
  for (let i = from.length; i < to.length; i++) out.push({ type: "msg", msg: to[i]! });
  return out;
}
