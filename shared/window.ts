// A loaded window of a transcript (SPEC §5 paging): the newest messages from the snapshot, plus
// any older pages fetched with `history`. Events only touch what is loaded; a message outside the
// window is fetched with its current content when the reader pages up to it.

import type { Msg, SessionEvent } from "./transcript";

export interface TranscriptWindow {
  messages: Msg[];
  hasOlder: boolean;
}

export function applyToWindow(w: TranscriptWindow, e: SessionEvent): TranscriptWindow {
  switch (e.type) {
    case "reset":
      return { messages: e.messages, hasOlder: e.hasOlder };
    case "msg": {
      const i = w.messages.findIndex((m) => m.id === e.msg.id);
      if (i >= 0) return { ...w, messages: replaceAt(w.messages, i, e.msg) };
      return e.isNew ? { ...w, messages: [...w.messages, e.msg] } : w;
    }
    case "delta":
      return patchMsg(w, e.msgId, (m) => {
        const part = m.parts[e.part];
        if (!part || (part.type !== "text" && part.type !== "thinking")) return m;
        // A part cut short holds only its start: the delta belongs after text this window doesn't
        // have. It stays cut (still marked `truncated`); fullPart has the whole of it.
        if (part.truncated) return m;
        return { ...m, parts: replaceAt(m.parts, e.part, { ...part, text: part.text + e.text }) };
      });
    case "tool":
      return patchMsg(w, e.msgId, (m) => ({
        ...m,
        parts: m.parts.map((p) => (p.type === "tool" && p.id === e.toolId ? { ...p, ...e.patch, type: "tool" as const, id: p.id } : p)),
      }));
    case "state":
    case "resync": // the caller subscribes again
      return w;
  }
}

/** An older page, put in front of the window. Messages already loaded keep their loaded copy. */
export function prependPage(w: TranscriptWindow, page: TranscriptWindow): TranscriptWindow {
  const have = new Set(w.messages.map((m) => m.id));
  return { messages: [...page.messages.filter((m) => !have.has(m.id)), ...w.messages], hasOlder: page.hasOlder };
}

function patchMsg(w: TranscriptWindow, id: string, fn: (m: Msg) => Msg): TranscriptWindow {
  const i = w.messages.findIndex((m) => m.id === id);
  return i < 0 ? w : { ...w, messages: replaceAt(w.messages, i, fn(w.messages[i]!)) };
}

const replaceAt = <T>(list: T[], i: number, v: T): T[] => list.map((x, j) => (j === i ? v : x));
