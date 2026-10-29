// Requests in the sessions (SPEC §7): the broker decides; this puts its open requests into every
// session that shows them (a subagent's request also shows in the sessions above it), tells modules
// (requestOpened, requestClosed), and passes on an answer given to a request that came back after a
// runner restart, when no harness was waiting on it: the session resumes with a message saying
// what was decided, and when the harness asks the same again the broker answers it at once.

import { randomUUID } from "node:crypto";
import { FROM_TETHER } from "../../../shared/fromTether";
import { HARNESS_LABELS, type Msg, type Request, type RequestAnswer } from "../../../shared/transcript";
import type { Decision, RequestAsk } from "./adapter";
import type { RequestBroker } from "./broker";
import type { Session } from "./session";
import type { SessionCore } from "./sessions";

const notice = (text: string, level: Msg["level"] = "info"): Msg => ({ id: `n-${randomUUID()}`, role: "notice", level, ts: Date.now(), parts: [{ type: "text", text }] });

/** What a request is about, in a sentence: "run `ls -la`", "use Write on src/a.ts". */
export function describeRequest(r: Pick<Request, "tool" | "input" | "command" | "path">): string {
  const i = (r.input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const cmd = r.command ?? str(i.command);
  const path = r.path ?? str(i.file_path) ?? str(i.path) ?? str(i.notebook_path);
  if (cmd) return `run \`${cmd.length > 120 ? `${cmd.slice(0, 120)}…` : cmd}\``;
  if (path) return `use ${r.tool ?? "a tool"} on ${path}`;
  return `use ${r.tool ?? "a tool"}`;
}

/** Who a policy step's source is, for a notice: "judge" -> "The judge". */
const sourceLabel = (s: string) => (s === "judge" ? "The judge" : s === "rule" ? "A rule" : s.charAt(0).toUpperCase() + s.slice(1));

/**
 * The message that tells a resumed session what was decided after a restart (none: nothing to
 * say). It is marked as Tether's (shared/fromTether.ts), so it never reads as the person's own text.
 */
export function restoredMessage(r: Request, a: RequestAnswer): string | undefined {
  const text = ((): string | undefined => {
    if (r.kind === "question") {
      if (!a.allow) return a.reason?.trim() ? `The user didn't answer your question and said: ${a.reason.trim()}` : undefined;
      const qs = r.questions?.length ? r.questions.map((q) => q.question) : [r.question ?? "your question"];
      const lines = qs.map((q, i) => [q, a.answers?.[i]?.trim()] as const).filter(([, x]) => x);
      return lines.length === 1 ? `The user answered "${lines[0]![0]}": ${lines[0]![1]}` : `The user answered:\n${lines.map(([q, x]) => `- ${q} ${x}`).join("\n")}`;
    }
    if (!a.allow) return a.reason?.trim() ? `The user denied your request to ${describeRequest(r)} and said: ${a.reason.trim()}` : undefined;
    return r.plan !== undefined ? "The user approved your plan. Go ahead." : `The user approved your request to ${describeRequest(r)}. Go ahead.`;
  })();
  return text && FROM_TETHER + text;
}

/** Errors that mean a session is gone for good (not a passing failure to open it). */
const GONE = /isn't on this runner|isn't a session id|can't drive/i;

export interface DeskHooks {
  /** sends a message as the person would (a session resuming after a restored answer) */
  send(sessionId: string, text: string): Promise<void>;
  setPermissionMode(sessionId: string, mode: string): Promise<void>;
}

export class RequestDesk {
  constructor(
    private core: SessionCore,
    readonly broker: RequestBroker,
    private hooks: DeskHooks,
  ) {
    const bus = core.o.bus;
    core.requestsFor = (id) => broker.forSession(id);
    broker.hooks = {
      changed: (ids) => this.sync(ids),
      opened: (request) => bus.emit("requestOpened", { request }),
      closed: (r, outcome, how) => {
        bus.emit("requestClosed", { sessionId: r.sessionId, requestId: r.id, outcome, source: how.source, ...(how.reason ? { reason: how.reason } : {}) });
        // A policy step decided: say so where the reader looks, with its reason.
        if (how.source !== "person" && how.source !== "tether" && (outcome === "allowed" || outcome === "denied")) {
          const s = core.sessions.get(r.sessionId);
          s?.apply({ type: "msg", msg: notice(`${sourceLabel(how.source)} ${outcome} ${this.harness(r.sessionId)}'s request to ${describeRequest(r)}${how.reason ? `: ${how.reason}` : "."}`, outcome === "denied" ? "warning" : "info") });
        }
        if (how.restored && how.answer && how.source === "person") void this.passOn(r, how.answer, how.chain.at(-1)!);
      },
    };
    // Answers kept for the harness asking again hold only for the turn that passes them on: any
    // other turn starting means you moved on.
    bus.on("turnStarted", ({ sessionId }) => {
      if (!this.resuming.delete(sessionId)) broker.forgetPredecided(sessionId);
    });
    // A turn that ran and ended without the harness asking again: what was restored is stale.
    bus.on("turnEnded", ({ sessionId }) => {
      broker.forgetPredecided(sessionId);
      broker.cancel((_r, chain, restored) => restored && chain.at(-1) === sessionId);
    });
  }

  /** Root sessions passing on a restored answer: their next turn start is that message's. */
  private resuming = new Set<string>();

  /** A notice in a session, its transcript read first if nobody has opened it yet (else it'd be lost). */
  private async say(sessionId: string, msg: Msg) {
    const s = this.core.sessions.get(sessionId);
    if (!s) return;
    await this.core.load(s).catch(() => {});
    s.apply({ type: "msg", msg });
  }

  /** The harness's name for notices ("Claude Code"). */
  private harness(sessionId: string) {
    const h = this.core.sessions.get(sessionId)?.summary.harness;
    return h ? HARNESS_LABELS[h] : "The agent";
  }

  /**
   * At start: sessions with requests saved from before the restart are opened, so they show. One
   * that is gone for good drops its requests; one that fails to open for another reason (a slow
   * disk, a store being written) keeps them and is tried again.
   */
  async restore(attempt = 0) {
    let retry = false;
    for (const id of this.broker.sessions(true)) {
      if (this.core.sessions.has(id)) continue;
      const s = await this.core.open(id).catch((e) => {
        const msg = String(e?.message ?? e);
        if (GONE.test(msg)) {
          this.core.log(`dropping the open requests of ${id}: ${msg}`);
          this.broker.cancel((_r, chain) => chain.at(-1) === id);
        } else {
          this.core.log(`couldn't reopen ${id} for its open requests (will try again): ${msg}`);
          retry = true;
        }
        return undefined;
      });
      if (s) this.sync([s.id]);
    }
    if (retry && attempt < 20) setTimeout(() => void this.restore(attempt + 1), 30_000).unref?.();
    // Subagents that asked show them in their own view too, when they can still be opened.
    for (const id of this.broker.sessions()) if (!this.core.sessions.has(id)) await this.core.open(id).then((s) => this.sync([s.id]), () => {});
  }

  /** A driver asks, through a session's sink. */
  async ask(s: Session, r: RequestAsk, signal?: AbortSignal): Promise<Decision> {
    const chain = this.chain(s);
    const root = this.core.sessions.get(chain.at(-1)!) ?? s;
    const request: Request = { ...r, id: randomUUID(), sessionId: s.id, openedAt: this.core.now(), ...(s.summary.parentSessionId ? { agent: s.summary.title } : {}) };
    const { source: _s, requestId: _r, ...d } = await this.broker.decide(request, chain, { projectPath: root.summary.projectPath, permissionMode: root.state.permissionMode }, signal);
    return d;
  }

  answer(requestId: string, a: RequestAnswer) {
    this.broker.answer(requestId, a);
  }

  /** The harness stopped waiting on these (a turn stopped, a driver went away). */
  cancel(match: (r: Request, chain: string[], restored: boolean) => boolean) {
    this.broker.cancel(match);
  }

  /** The session and every session above it. */
  private chain(s: Session): string[] {
    const out = [s.id];
    let p = s.summary.parentSessionId;
    while (p && !out.includes(p)) {
      out.push(p);
      p = this.core.sessions.get(p)?.summary.parentSessionId;
    }
    return out;
  }

  /** Puts the broker's open requests into these sessions' state and rows. */
  private sync(ids: string[]) {
    for (const id of ids) {
      const s = this.core.sessions.get(id);
      if (!s) continue;
      s.setState({ requests: this.broker.forSession(id) });
      this.core.touch(s);
      if (!s.state.requests.length) this.core.scheduleEvict(s);
    }
  }

  /** An answer to a restored request: the session resumes with a message saying what was decided. */
  private async passOn(r: Request, a: RequestAnswer, root: string) {
    const s = this.core.sessions.get(root);
    try {
      // As live: approving a plan leaves plan mode (for the chosen mode, else the plain one).
      const mode = a.allow ? (a.mode ?? r.approveMode) : undefined;
      if (mode) await this.hooks.setPermissionMode(root, mode);
      const text = restoredMessage(r, a);
      if (!text) return void (await this.say(root, notice(`You denied ${this.harness(root)}'s request to ${describeRequest(r)}.`)));
      this.resuming.add(root);
      try {
        await this.hooks.send(root, text);
      } finally {
        this.resuming.delete(root);
      }
    } catch (e: any) {
      await this.say(root, notice(`Couldn't pass your answer on to ${this.harness(root)}: ${e?.message ?? e} Tell it in a message instead.`, "warning"));
    }
  }
}
