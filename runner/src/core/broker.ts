// The request broker (SPEC §7): every permission prompt and question from any driver comes here.
//
//   driver ─► broker.decide(request) ─► [policy steps] ─► person (any device) ─► answer ─► driver
//
// Policy steps are an ordered list of functions that allow, deny or pass, each verdict carrying a
// source ("judge", "rule", …) and a reason for display. The core ships with none: every request
// goes to a person. The judge, rules, "Always allow" and timed full access come back as steps.
//
// Answers are idempotent by request id: the first wins, a later one is told "Already answered.".
// Open requests are saved (runner.json) and come back after a runner restart with nobody waiting on
// them. When the harness asks again (its session resumed), the broker matches the new ask to the
// saved request by session, tool and input, so it keeps its id: answered already, it is decided at
// once with that answer; still open, the new ask waits on it.
//
// The broker knows nothing of sessions or the wire: `hooks` tell the core what changed.

import { createHash } from "node:crypto";
import { capRequest } from "../../../shared/limits";
import type { Request, RequestAnswer } from "../../../shared/transcript";
import { RESOLVED_ELSEWHERE, type Decision } from "./adapter";
import type { RequestOutcome } from "./events";

export type PolicyVerdict = { verdict: "allow"; source: string; reason?: string } | { verdict: "deny"; source: string; reason: string } | { verdict: "undecided" };

/** What a policy step knows besides the request. */
export interface PolicyContext {
  /** the main session the request belongs to (the subagent's parent, for a subagent's request) */
  rootSessionId: string;
  projectPath: string;
  permissionMode?: string;
}

export type PolicyStep = (r: Request, ctx: PolicyContext) => PolicyVerdict | Promise<PolicyVerdict>;

/** A decision and who made it: "person", or a policy step's source. */
export type BrokerResult = Decision & { source: string; requestId: string };

/** An open request as runner.json keeps it. */
export interface SavedRequest {
  /** as shown (its input trimmed to travel) */
  request: Request;
  /** the tool and its whole input, digested: a harness asking again matches by it */
  key: string;
  /** the sessions it shows in: the one that asked, then each one above it (the last is the root) */
  chain: string[];
}

export interface BrokerHooks {
  /** these sessions' open requests changed */
  changed(sessionIds: string[]): void;
  opened(r: Request): void;
  /**
   * `source`: "person", a policy step's source, or "tether" (cancelled, resolved elsewhere).
   * `restored`: nobody was waiting on it (it came back after a restart): the core passes the answer on.
   */
  closed(r: Request, outcome: RequestOutcome, how: { source: string; reason?: string; restored: boolean; answer?: RequestAnswer; chain: string[] }): void;
}

export const ALREADY_ANSWERED = "Already answered.";
export const NOT_OPEN = "That request is no longer open.";

/** What the model reads when a person denies without a reason (the turn stops too). */
export const DENIED = "The user denied this request. Stop and wait for their next message.";
export const deniedBecause = (reason: string) => `The user denied this request and said: ${reason}`;
export const DISMISSED = "The user dismissed the question without answering.";

/** JSON with object keys in order, so equal inputs digest the same. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

export const requestKey = (tool: string | undefined, input: unknown) => createHash("sha256").update(`${tool ?? ""}\u0000${stable(input)}`).digest("hex").slice(0, 32);

interface Open extends SavedRequest {
  /** the driver waiting on it; absent for one restored after a restart */
  resolve?: (d: BrokerResult) => void;
}

/** An answer given to a restored request, kept for when the harness asks again. */
interface Predecided {
  key: string;
  root: string;
  requestId: string;
  decision: Decision;
  at: number;
}

const CLOSED_KEPT = 2000;
const PREDECIDED_MS = 30 * 60_000;

const noHooks: BrokerHooks = { changed() {}, opened() {}, closed() {} };

export class RequestBroker {
  hooks: BrokerHooks = noHooks;
  private open = new Map<string, Open>();
  /** recently closed requests by id: a second answer is told why it's too late */
  private closedIds = new Map<string, RequestOutcome>();
  private predecided: Predecided[] = [];
  /** shutting down: what's open stays saved for the next start */
  private frozen = false;
  private readonly now: () => number;

  constructor(
    private steps: PolicyStep[] = [],
    private o: { saved?: SavedRequest[]; persist?: (open: SavedRequest[]) => void; log?: (line: string) => void; now?: () => number } = {},
  ) {
    this.now = o.now ?? Date.now;
    for (const r of o.saved ?? [])
      if (r?.request?.id && typeof r.key === "string" && Array.isArray(r.chain) && r.chain.length) this.open.set(r.request.id, { request: r.request, key: r.key, chain: r.chain });
  }

  /** Open requests showing in a session (its own and its subagents'), oldest first. */
  forSession(sessionId: string): Request[] {
    return [...this.open.values()]
      .filter((o) => o.chain.includes(sessionId))
      .map((o) => o.request)
      .sort((a, b) => a.openedAt - b.openedAt);
  }

  /** Every session that shows an open request. */
  sessions(): string[] {
    return [...new Set([...this.open.values()].flatMap((o) => o.chain))];
  }

  /**
   * A driver asks. `request` has its whole input (policy steps see it all); `chain` is the
   * sessions it shows in, the asking one first. Settles when a step or a person decides, or with a
   * denial when `signal` aborts.
   */
  async decide(request: Request, chain: string[], ctx: Omit<PolicyContext, "rootSessionId">, signal?: AbortSignal): Promise<BrokerResult> {
    const key = requestKey(request.tool, request.input);
    const root = chain.at(-1)!;

    // Answered after a restart, before the harness asked again.
    this.predecided = this.predecided.filter((p) => this.now() - p.at < PREDECIDED_MS);
    const pre = this.predecided.findIndex((p) => p.root === root && p.key === key);
    if (pre >= 0) {
      const [p] = this.predecided.splice(pre, 1);
      return { ...p!.decision, source: "person", requestId: p!.requestId };
    }
    if (signal?.aborted) return this.gone(request.id);

    // Still open from before a restart: this ask takes it over, keeping its id.
    const restored = [...this.open.values()].find((o) => !o.resolve && o.key === key && o.chain.at(-1) === root);
    if (restored) return this.wait(restored, signal);

    const shown = capRequest(request);
    for (const step of this.steps) {
      let v: PolicyVerdict;
      try {
        v = await step(request, { ...ctx, rootSessionId: root });
      } catch (e: any) {
        this.o.log?.(`a policy step failed, so it passes: ${e?.message ?? e}`);
        continue;
      }
      if (v.verdict === "undecided") continue;
      if (signal?.aborted) return this.gone(request.id);
      const outcome = v.verdict === "allow" ? "allowed" : "denied";
      this.hooks.opened(shown);
      this.remember(request.id, outcome);
      this.hooks.closed(shown, outcome, { source: v.source, reason: v.reason, restored: false, chain });
      return { ...(v.verdict === "allow" ? { allow: true as const } : { allow: false as const, reason: v.reason }), source: v.source, requestId: request.id };
    }

    if (signal?.aborted) return this.gone(request.id);
    const o: Open = { request: shown, key, chain };
    this.open.set(request.id, o);
    this.save();
    this.hooks.opened(shown);
    this.hooks.changed(chain);
    return this.wait(o, signal);
  }

  private wait(o: Open, signal?: AbortSignal): Promise<BrokerResult> {
    return new Promise<BrokerResult>((resolve) => {
      const onAbort = () => this.close(o.request.id, signal?.reason === RESOLVED_ELSEWHERE ? "elsewhere" : "cancelled");
      o.resolve = (d) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(d);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** A request whose asker stopped waiting before anything was shown. */
  private gone(requestId: string): BrokerResult {
    return { allow: false, reason: "Cancelled.", source: "tether", requestId };
  }

  /**
   * A person answers. Throws when the request isn't open: "Already answered." when someone (on
   * any device) answered it first. Returns the request as it was shown.
   */
  answer(requestId: string, a: RequestAnswer): Request {
    const o = this.open.get(requestId);
    if (!o) {
      const was = this.closedIds.get(requestId);
      throw new Error(was === "allowed" || was === "denied" || was === "answered" ? ALREADY_ANSWERED : NOT_OPEN);
    }
    const r = o.request;
    let decision: Decision;
    if (a.allow) {
      const answers = (a.answers ?? []).map((x) => String(x ?? "").trim());
      if (r.kind === "question" && !answers.some(Boolean)) throw new Error("Pick or type an answer first.");
      if (a.mode && !r.approveAs?.some((m) => m.id === a.mode)) throw new Error("That isn't one of the ways to approve this.");
      decision = { allow: true, ...(r.kind === "question" ? { answers } : {}), ...(a.mode ? { mode: a.mode } : {}) };
    } else {
      const reason = a.reason?.trim();
      if (r.kind === "question") decision = { allow: false, reason: reason ? deniedBecause(reason) : DISMISSED };
      else decision = reason ? { allow: false, reason: deniedBecause(reason) } : { allow: false, reason: DENIED, interrupt: true };
    }
    const outcome: RequestOutcome = !a.allow ? "denied" : r.kind === "question" ? "answered" : "allowed";
    if (!o.resolve) this.predecided.push({ key: o.key, root: o.chain.at(-1)!, requestId, decision, at: this.now() });
    this.close(requestId, outcome, decision, "person", a);
    return r;
  }

  /** Closes open requests that match (their turn stopped, their driver went away, answered elsewhere). */
  cancel(match: (r: Request, chain: string[], restored: boolean) => boolean, outcome: "cancelled" | "elsewhere" = "cancelled") {
    for (const o of [...this.open.values()]) if (match(o.request, o.chain, !o.resolve)) this.close(o.request.id, outcome);
  }

  /** Answers kept for restored requests of this root session are dropped (its turn ended). */
  forgetPredecided(root: string) {
    this.predecided = this.predecided.filter((p) => p.root !== root);
  }

  /** Shutting down: what is open now stays saved, whatever happens to the drivers next. */
  freeze() {
    this.save();
    this.frozen = true;
  }

  private close(requestId: string, outcome: RequestOutcome, decision?: Decision, source = "tether", answer?: RequestAnswer) {
    const o = this.open.get(requestId);
    if (!o) return;
    this.open.delete(requestId);
    this.remember(requestId, outcome);
    this.save();
    this.hooks.changed(o.chain);
    this.hooks.closed(o.request, outcome, { source, restored: !o.resolve, answer, chain: o.chain });
    o.resolve?.({ ...(decision ?? { allow: false, reason: outcome === "elsewhere" ? "Answered elsewhere." : "Cancelled." }), source, requestId });
  }

  private remember(id: string, outcome: RequestOutcome) {
    this.closedIds.set(id, outcome);
    if (this.closedIds.size > CLOSED_KEPT) this.closedIds.delete(this.closedIds.keys().next().value!);
  }

  private save() {
    if (this.frozen) return;
    this.o.persist?.([...this.open.values()].map(({ request, key, chain }) => ({ request, key, chain })));
  }
}
