// Side chats (SPEC §16a): a question asked beside a session without disturbing it. A side chat is a
// fork (the fork module, SessionActions.fork) through the session's last finished turn, in the
// harness's read-only mode (capabilities.readOnlyMode), marked `sideOf` the session: the lists leave
// it out and the session shows it under its header. The core keeps it read-only (its mode can't
// change, and its approvals are refused); this module makes them and brings them back.
//
// Bring back is a turn of the side chat's own (Tether asks it for a short summary); the summary
// comes back as text for the session's box, to edit and send. Nothing goes into the session itself.

import { resolve } from "node:path";
import { BRING_BACK_PROMPT, bringBackDraft, sideChatTitle } from "../../../../shared/sideChat";
import { FROM_TETHER } from "../../../../shared/fromTether";
import { HARNESS_LABELS, type Msg } from "../../../../shared/transcript";
import type { Module, ModuleContext } from "..";

/** How long Bring back waits for the summary (the relay gives up on an op after 120 s). */
export const BRING_BACK_MS = 100_000;

/** Bring back's own message, as the transcript shows it (Tether's marker may be read off). */
export const isBringBack = (m: Msg) => m.role === "user" && m.parts.some((p) => p.type === "text" && p.text.includes(BRING_BACK_PROMPT.slice(FROM_TETHER.length)));

/** The text of the side chat's last reply after the last message sent to it, or after the last `after` (none: no reply). */
export function lastReply(msgs: Msg[], after?: (m: Msg) => boolean): string | undefined {
  const from = msgs.findLastIndex(after ?? ((m) => m.role === "user"));
  if (after && from < 0) return undefined;
  const reply = msgs.slice(from + 1).findLast((m) => m.role === "assistant" && !m.error && m.parts.some((p) => p.type === "text" && p.text.trim()));
  const text = reply?.parts.map((p) => (p.type === "text" ? p.text : "")).filter((t) => t.trim()).join("\n\n").trim();
  return text || undefined;
}

export class SideChats {
  /** side chats writing a summary now */
  private bringing = new Set<string>();

  constructor(
    private ctx: Pick<ModuleContext, "sessions" | "bus" | "log" | "homeFolder">,
    private bringBackMs = BRING_BACK_MS,
  ) {}

  /** A side chat beside `parentId`, asked `question` when there is one. Its id. */
  async open(parentId: string, question = ""): Promise<string> {
    const look = await this.ctx.sessions.open(parentId);
    if (look.summary.sideOf) throw new Error("A side chat can't have side chats. Ask it here.");
    if (look.summary.parentSessionId) throw new Error("A subagent can't have side chats. Open one on its main session.");
    if (this.ctx.homeFolder && resolve(look.summary.projectPath) === resolve(this.ctx.homeFolder)) throw new Error("The Home agent's chats can't have side chats.");
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

  /** Closes side chat `id`: a turn it runs stops, then it's archived (its session's Side chats has it). */
  async close(id: string): Promise<void> {
    const look = await this.ctx.sessions.open(id);
    if (!look.summary.sideOf) throw new Error("That isn't a side chat.");
    if (look.status !== "idle" || look.busy) await this.ctx.sessions.interrupt(id).catch((e) => this.ctx.log(`couldn't stop side chat ${id}: ${(e as Error)?.message ?? e}`));
    await this.ctx.sessions.setArchived(id, true);
  }

  /** Asks side chat `id` for a short summary and returns it as a draft for its session's box. */
  async bringBack(id: string): Promise<string> {
    const look = await this.ctx.sessions.open(id);
    if (!look.summary.sideOf) throw new Error("That isn't a side chat.");
    if (this.bringing.has(id)) throw new Error("It's already writing a summary.");
    if (look.status !== "idle" || look.requests.length) throw new Error("The side chat is still answering. Bring it back when it's done.");
    this.bringing.add(id);
    try {
      const ended = this.summaryEnd(id);
      try {
        await this.ctx.sessions.send(id, BRING_BACK_PROMPT);
      } catch (e) {
        ended.cancel();
        throw e;
      }
      const end = await ended.done;
      if (end.error) throw new Error(`The side chat couldn't write a summary: ${end.error}`);
      if (end.stopped) throw new Error("The summary was stopped.");
      const text = lastReply(await this.ctx.sessions.recent(id, 30), isBringBack);
      if (!text) throw new Error("The side chat didn't write a summary.");
      return bringBackDraft(text);
    } finally {
      this.bringing.delete(id);
    }
  }

  /**
   * The end of the turn Bring back's own message started (a rate-limit retry isn't one; a turn
   * ending before that message showed is another's), or a timeout.
   */
  private summaryEnd(id: string) {
    let off = () => {};
    let offMsg = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sent = false;
    const done = new Promise<{ error?: string; stopped?: boolean }>((resolve, reject) => {
      offMsg = this.ctx.bus.on("message", (e) => {
        if (e.sessionId === id && isBringBack(e.msg)) sent = true;
      });
      off = this.ctx.bus.on("turnEnded", (e) => {
        if (e.sessionId !== id || e.recovering || !sent) return;
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
      offMsg();
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
    ctx.ops.register("closeSideChat", async (a) => (await side.close(str(a.sessionId)), null));
  },
};
