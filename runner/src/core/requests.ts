// Requests in the sessions (SPEC §7): the broker decides; this puts its open requests into every
// session that shows them (a subagent's request also shows in the sessions above it), tells modules
// (requestOpened, requestClosed), and passes on an answer given to a request that came back after a
// runner restart, when no harness was waiting on it: the session resumes with a message saying
// what was decided, and when the harness asks the same again the broker answers it at once.

import { randomUUID } from "node:crypto";
import type { Msg, Request, RequestAnswer } from "../../../shared/transcript";
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

/** The message that tells a resumed session what was decided after a restart (none: nothing to say). */
export function restoredMessage(r: Request, a: RequestAnswer): string | undefined {
  if (r.kind === "question") {
    if (!a.allow) return a.reason?.trim() ? `I won't answer your question: ${a.reason.trim()}` : undefined;
    const qs = r.questions?.length ? r.questions.map((q) => q.question) : [r.question ?? "your question"];
    const lines = qs.map((q, i) => [q, a.answers?.[i]?.trim()] as const).filter(([, x]) => x);
    return lines.length === 1 ? `My answer to "${lines[0]![0]}": ${lines[0]![1]}` : `My answers:\n${lines.map(([q, x]) => `- ${q} ${x}`).join("\n")}`;
  }
  if (!a.allow) return a.reason?.trim() ? `I denied your request to ${describeRequest(r)}: ${a.reason.trim()}` : undefined;
  return r.plan ? "Your plan is approved. Go ahead." : `Approved: go ahead and ${describeRequest(r)}.`;
}

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
          s?.apply({ type: "msg", msg: notice(`${sourceLabel(how.source)} ${outcome} Claude's request to ${describeRequest(r)}${how.reason ? `: ${how.reason}` : "."}`, outcome === "denied" ? "warning" : "info") });
        }
        if (how.restored && how.answer && how.source === "person") void this.passOn(r, how.answer, how.chain.at(-1)!);
      },
    };
    // A turn that ran and ended without the harness asking again: what was restored is stale.
    bus.on("turnEnded", ({ sessionId }) => {
      broker.forgetPredecided(sessionId);
      broker.cancel((_r, chain, restored) => restored && chain.at(-1) === sessionId);
    });
  }

  /** At start: sessions with requests saved from before the restart are opened, so they show. */
  async restore() {
    for (const id of this.broker.sessions(true)) {
      const s = await this.core.open(id).catch((e) => void this.core.log(`dropping the open requests of ${id}: ${e?.message ?? e}`));
      if (s) this.sync([s.id]);
      // A session that is gone can't be asked again: its requests go too.
      else this.broker.cancel((_r, chain) => chain.at(-1) === id);
    }
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
      if (a.allow && a.mode) await this.hooks.setPermissionMode(root, a.mode);
      const text = restoredMessage(r, a);
      if (text) await this.hooks.send(root, text);
      else s?.apply({ type: "msg", msg: notice(`You denied Claude's request to ${describeRequest(r)}.`) });
    } catch (e: any) {
      s?.apply({ type: "msg", msg: notice(`Couldn't pass your answer on to Claude: ${e?.message ?? e} Tell it in a message instead.`, "warning") });
    }
  }
}
