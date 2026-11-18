// Forks a session (SPEC §16): a new session with the same conversation, or with it up to one reply,
// in the same folder, on the same harness and source, with the same model, effort and mode. The
// original is never changed. The harness makes the fork in its own store (Adapter.fork); nothing
// starts and nothing is billed until the fork's first send. Other modules fork through
// SessionActions.fork (side chats, §7).

import { parseSessionId } from "../../../../shared/ids";
import { forkedNotice, forkPoints, forkTitle, wholeForkPoint, type ForkedFrom } from "../../../../shared/fork";
import { HARNESS_LABELS, type Msg } from "../../../../shared/transcript";
import type { Adapter, StartOpts } from "../../core/adapter";
import { Mover } from "../move";
import { movedBase } from "../../core/moved";
import type { AdoptExtra, ForkOptions, Module, ModuleContext, SessionLook } from "..";

/** Why a session can't be forked at all (a running turn isn't a reason: its finished part is forked). */
export function forkRefusal(s: SessionLook, a: Adapter | undefined): string | undefined {
  if (s.summary.parentSessionId) return "A subagent can't be forked. Fork its main session.";
  if (!a?.capabilities.fork || !a.fork) return `${HARNESS_LABELS[s.summary.harness] ?? s.summary.harness} sessions can't be forked yet.`;
  // The fork takes the session's source: one that isn't confirmed yet can't be shown on it.
  if (s.state.nextBilling) return "Its new source isn't confirmed yet. Send it a message first.";
  return undefined;
}

export class Forker {
  constructor(
    private ctx: Pick<ModuleContext, "sessions" | "log">,
    /** a fork the harness can't make itself: a copy of the history (Mover.copy) */
    private copy?: (id: string, upTo: string | undefined, title: string, extra: AdoptExtra) => Promise<string>,
  ) {}

  private adapter(h: string) {
    return this.ctx.sessions.adapters().find((x) => x.id === h);
  }

  /**
   * A turn may be running: in Tether, in another Codex client, or in a TUI that took the session over
   * (a handoff harness: Tether doesn't follow its turns). Then only finished turns are forked.
   */
  private async running(a: Adapter, s: SessionLook) {
    const tui = a.capabilities.terminal === "handoff" && (s.state.mode === "terminal" || !!s.state.terminal);
    return s.status !== "idle" || tui || !!(await a.move?.busy?.(s.summary.nativeId).catch(() => false));
  }

  async fork(id: string, o: ForkOptions = {}): Promise<string> {
    if (!parseSessionId(id)) throw new Error("That isn't a session id.");
    const look = await this.ctx.sessions.open(id);
    const a = this.adapter(look.summary.harness);
    const why = forkRefusal(look, a);
    if (why) throw new Error(why);
    const { harness, nativeId, projectPath, title } = look.summary;
    const running = await this.running(a!, look);
    const msgs = await a!.readHistory(nativeId, projectPath);
    let upTo: string | undefined;
    if (o.messageId) {
      if (!forkPoints(msgs, running).has(o.messageId)) throw new Error(refusedPoint(msgs, o.messageId, running));
      upTo = o.messageId;
    } else {
      const point = wholeForkPoint(msgs, running);
      if (!point) throw new Error(running ? "No turn has finished yet. Wait for this one to end." : "Nothing to fork yet.");
      upTo = point.upTo;
    }
    const forkedFrom: ForkedFrom = { sessionId: id, ...(upTo ? { messageId: upTo } : {}), title };
    // The original's key preferences go with it; its plan-runs-out switch is ticked per session, so it doesn't.
    const { lastKey, fallbackKeys } = look.state;
    const extra: AdoptExtra = { stored: true, forkedFrom, keys: { ...(lastKey ? { lastKey } : {}), ...(fallbackKeys !== undefined ? { fallbackKeys: [...fallbackKeys] } : {}) } };
    const name = forkTitle(title);
    const notice: Msg = { id: `n-forked-from-${id}`, role: "notice", level: "info", ts: Date.now(), parts: [{ type: "text", text: forkedNotice(title) }], link: { sessionId: id, label: "Open it" } };
    /** Where the fork's own conversation begins: under what it took from the original. */
    const mark = async (forked: string) => {
      const after = (await a!.readHistory(parseSessionId(forked)!.nativeId, projectPath).catch(() => [] as Msg[])).at(-1)?.id;
      await this.ctx.sessions.notice(forked, notice, after ? { after } : {});
    };
    let forked: string;
    if (a!.fork!.copyInstead?.(nativeId)) {
      if (!this.copy) throw new Error("This session can't be forked here.");
      forked = await this.copy(id, upTo, name, extra);
      await mark(forked).catch((e) => this.ctx.log(`the fork ${forked} has no notice: ${e?.message ?? e}`));
    } else {
      const { model, effort, permissionMode } = look.state;
      const opts: StartOpts = { ...(model && model !== "default" ? { model } : {}), ...(effort ? { effort } : {}), ...(permissionMode ? { permissionMode } : {}) };
      const made = await a!.fork!.fork({ nativeId, projectPath, ...(upTo ? { upTo } : {}), title: name });
      try {
        forked = await this.ctx.sessions.adopt(harness, made, projectPath, opts, await this.ctx.sessions.sourceOf(id), undefined, extra);
        await mark(forked);
      } catch (e) {
        // No half-made fork: its store goes, and its row, if it got one, is archived.
        await a!.fork!.discard?.(made, projectPath).catch(() => {});
        await this.ctx.sessions.setArchived(`${harness}:${made}`, true).catch(() => {});
        throw e;
      }
    }
    this.ctx.log(`forked ${id}${upTo ? ` through ${upTo}` : ""} as ${forked}`);
    return forked;
  }
}

/** Why a message isn't somewhere a fork can end. */
function refusedPoint(msgs: Msg[], id: string, running: boolean): string {
  const m = msgs.find((x) => x.id === id);
  if (!m) return "That message isn't in the session any more.";
  if (running && forkPoints(msgs, false).has(id)) return "That turn hasn't finished. Wait for it to end.";
  return "A fork ends at the reply that ends a turn. Fork from there.";
}

export const forkModule: Module = {
  name: "fork",
  start(ctx) {
    // A copy keeps its history where moves do (core/moved.ts): the harness may be told to read it there.
    const mover = new Mover({ ...ctx, dataDir: movedBase() });
    const forker = new Forker(ctx, (id, upTo, title, extra) => mover.copy(id, upTo, title, extra));
    ctx.sessions.forker((id, o) => forker.fork(id, o));
    ctx.ops.register("forkSession", async (a) => ({ sessionId: await ctx.sessions.fork(String(a.sessionId ?? ""), typeof a.messageId === "string" && a.messageId ? { messageId: a.messageId } : {}) }));
  },
};
