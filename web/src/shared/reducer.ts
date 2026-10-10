import type { LiveState, Msg, Part, SessionEvent } from "./protocol";

export interface Transcript {
  messages: Msg[];
  state: LiveState;
}

export function emptyState(): LiveState {
  return { status: "idle", queued: [], statuses: {}, pendingUi: [] };
}

/** Applies one event in place. Used by the runner (authoritative copy) and by browsers. */
export function applyEvent(t: Transcript, e: SessionEvent): void {
  switch (e.type) {
    case "msg": {
      const i = t.messages.findIndex((m) => m.id === e.msg.id);
      if (i >= 0) t.messages[i] = e.msg;
      else t.messages.push(e.msg);
      break;
    }
    case "delta": {
      const m = findMsg(t, e.msgId);
      if (!m) break;
      let p = m.parts[e.part];
      if (!p) {
        p = { type: e.kind, text: "" };
        m.parts[e.part] = p;
      }
      if (p.type === "text" || p.type === "thinking") p.text += e.text;
      break;
    }
    case "tool": {
      const m = findMsg(t, e.msgId);
      const p = m?.parts.find((x): x is Extract<Part, { type: "tool" }> => x.type === "tool" && x.id === e.toolId);
      if (p) {
        Object.assign(p, e.patch);
        // A verdict, or the call ending, settles a pending judgment.
        if (!p.judging || p.guard || p.status !== "running") delete p.judging;
      }
      break;
    }
    case "state":
      Object.assign(t.state, e.state);
      break;
    case "reset":
      t.messages = e.messages;
      break;
    case "toast":
      break;
  }
}

function findMsg(t: Transcript, id: string): Msg | undefined {
  for (let i = t.messages.length - 1; i >= 0; i--) if (t.messages[i]!.id === id) return t.messages[i];
  return undefined;
}

/** Finds the tool part with this id anywhere in the transcript (tool results arrive after the call). */
export function findTool(messages: Msg[], toolId: string): { msg: Msg; part: Extract<Part, { type: "tool" }> } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    for (const part of msg.parts) if (part.type === "tool" && part.id === toolId) return { msg, part };
  }
  return undefined;
}
