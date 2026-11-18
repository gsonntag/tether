// Side chats (SPEC §16a): a question asked beside a session without disturbing it. A side chat is a
// fork (the fork module, SessionActions.fork) through the session's last finished turn, in the
// harness's read-only mode (capabilities.readOnlyMode), marked `sideOf` the session: the lists leave
// it out and the session shows it under its header. The core keeps it read-only (its mode can't
// change, and its approvals are refused); this module makes them and brings them back.
//
// Bring back is a turn of the side chat's own (Tether asks it for a short summary); the summary
// comes back as text for the session's box, to edit and send. Nothing goes into the session itself.

import { BRING_BACK_PROMPT, bringBackDraft, sideChatTitle } from "../../../../shared/sideChat";
import { HARNESS_LABELS, type Msg } from "../../../../shared/transcript";
import type { Module, ModuleContext } from "..";

/** How long Bring back waits for the summary (the relay gives up on an op after 120 s). */
export const BRING_BACK_MS = 100_000;

/** The text of the side chat's last reply, after the last message sent to it. */
export function lastReply(msgs: Msg[]): string | undefined {
  const from = msgs.findLastIndex((m) => m.role === "user");
  const reply = msgs.slice(from + 1).findLast((m) => m.role === "assistant" && !m.error && m.parts.some((p) => p.type === "text" && p.text.trim()));
  const text = reply?.parts.map((p) => (p.type === "text" ? p.text : "")).filter((t) => t.trim()).join("\n\n").trim();
  return text || undefined;
}

export class SideChats {
  /** side chats writing a summary now */
  private bringing = new Set<string>();

  constructor(
    private ctx: Pick<ModuleContext, "sessions" | "bus" | "log">,
    private bringBackMs = BRING_BACK_MS,
  ) {}

  /** A side chat beside `parentId`, asked `question` when there is one. Its id. */
  async open(parentId: string, question = ""): Promise<string> {
    const look = await this.ctx.sessions.open(parentId);
    if (look.summary.sideOf) throw new Error("A side chat can't have side chats. Ask it here.");
    if (look.summary.parentSessionId) throw new Error("A subagent can't have side chats. Open one on its main session.");
    const mode = this.ctx.sessions.adapters().find((a) => a.id === look.summary.harness)?.capabilities.readOnlyMode;
    if (!mode) throw new Error(`${HARNESS_LABELS[look.summary.harness] ?? look.summary.harness} sessions can't have side chats yet.`);
    const q = question.trim();
    const id = await this.ctx.sessions.fork(parentId, { permissionMode: mode, sideOf: parentId, title: sideChatTitle(q, look.summary.title) });
    this.ctx.log(`side chat ${id} beside ${parentId}`);
    if (q)
      try {
        await this.ctx.sessions.tell(id, q);
      } catch (e) {
        // Nothing asked, nothing to keep.
        await this.ctx.sessions.setArchived(id, true).catch(() => {});
        throw e;
      }
    return id;
  }

  /** Asks side chat `id` for a short summary and returns it as a draft for its session's box. */
  async bringBack(id: string): Promise<string> {
    const look = await this.ctx.sessions.open(id);
    if (!look.summary.sideOf) throw new Error("That isn't a side chat.");
    if (this.bringing.has(id)) throw new Error("It's already writing a summary.");
    if (look.status !== "idle" || look.requests.length) throw new Error("The side chat is still answering. Bring it back when it's done.");
    this.bringing.add(id);
    try {
      const ended = this.turnEnd(id);
      try {
        await this.ctx.sessions.send(id, BRING_BACK_PROMPT);
      } catch (e) {
        ended.cancel();
        throw e;
      }
      const end = await ended.done;
      if (end.error) throw new Error(`The side chat couldn't write a summary: ${end.error}`);
      if (end.stopped) throw new Error("The summary was stopped.");
      const text = lastReply(await this.ctx.sessions.recent(id, 30));
      if (!text) throw new Error("The side chat didn't write a summary.");
      return bringBackDraft(text);
    } finally {
      this.bringing.delete(id);
    }
  }

  /** The end of the side chat's next turn (a rate-limit retry isn't one), or a timeout. */
  private turnEnd(id: string) {
    let off = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = new Promise<{ error?: string; stopped?: boolean }>((resolve, reject) => {
      off = this.ctx.bus.on("turnEnded", (e) => {
        if (e.sessionId !== id || e.recovering) return;
        cancel();
        resolve(e);
      });
      timer = setTimeout(() => {
        cancel();
        reject(new Error("The summary is taking a while. It'll be in the side chat when it's done."));
      }, this.bringBackMs);
    });
    const cancel = () => {
      off();
      clearTimeout(timer);
    };
    return { done, cancel };
  }
}

export const sideChatsModule: Module = {
  name: "sideChats",
  start(ctx) {
    const side = new SideChats(ctx);
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    ctx.ops.register("openSideChat", async (a) => ({ sessionId: await side.open(str(a.sessionId), str(a.question)) }));
    ctx.ops.register("bringBack", async (a) => ({ text: await side.bringBack(str(a.sessionId)) }));
  },
};
