// Buffers every driver sink call during a provisional fallback start (SPEC §10 / R6.1).
// Nothing reaches the session's transcript, live state or bus until commit() replays the buffer
// in order into the live sink. On discard(), everything buffered is dropped and pending requests
// resolve with a cancellation denial.

import type { SessionCost } from "../../../shared/costs";
import type { LiveState, Msg, PlanUsage } from "../../../shared/transcript";
import type { Decision, PlanIdentity, RequestAsk, Sink, SubagentStart, TranscriptEvent } from "./adapter";
import { Transcript } from "./transcript";

type BufferedCall =
  | { type: "cost"; report: SessionCost & { id: string } }
  | { type: "event"; e: TranscriptEvent }
  | { type: "state"; patch: Partial<Omit<LiveState, "mode" | "requests" | "queue">> }
  | { type: "plan"; p: PlanUsage; identity?: PlanIdentity }
  | { type: "limitReached"; hit: { resetsAt?: number } }
  | { type: "rateLimited"; hit: { retryAt?: number } }
  | { type: "nativeId"; id: string }
  | { type: "subagent"; start: SubagentStart; child: BufferedSink }
  | { type: "ended" }
  | { type: "relayed"; nativeId: string }
  | { type: "mainFree" }
  | { type: "mainChanged" };

interface PendingRequest {
  ask: RequestAsk;
  signal?: AbortSignal;
  resolve: (decision: Decision) => void;
  onAbort?: () => void;
}

export class BufferedSink implements Sink {
  private queue: BufferedCall[] = [];
  private requests: PendingRequest[] = [];
  private children: BufferedSink[] = [];
  private live?: Sink;
  private discarded = false;
  private local: Transcript;

  constructor(private fallbackMessage?: (id: string) => Msg | undefined) {
    this.local = new Transcript();
  }

  cost(report: SessionCost & { id: string }) {
    if (this.discarded) return;
    if (this.live) return this.live.cost?.(report);
    this.queue.push({ type: "cost", report });
  }

  event(e: TranscriptEvent) {
    if (this.discarded) return;
    if (this.live) return this.live.event(e);
    // Keep a local view of streamed/upserted messages so message(id) stays coherent before commit.
    if (e.type === "delta" || e.type === "tool") {
      const id = e.msgId;
      if (!this.local.get(id)) {
        const seeded = this.fallbackMessage?.(id);
        if (seeded) this.local.apply({ type: "msg", msg: structuredClone(seeded) });
      }
    }
    this.local.apply(e);
    this.queue.push({ type: "event", e });
  }

  message(id: string): Msg | undefined {
    if (this.live) return this.live.message(id);
    return this.local.get(id) ?? this.fallbackMessage?.(id);
  }

  state(patch: Partial<Omit<LiveState, "mode" | "requests" | "queue">>) {
    if (this.discarded) return;
    if (this.live) return this.live.state(patch);
    this.queue.push({ type: "state", patch });
  }

  request(r: RequestAsk, signal?: AbortSignal): Promise<Decision> {
    if (this.discarded || signal?.aborted) return Promise.resolve({ allow: false, reason: "Cancelled." });
    if (this.live) return this.live.request(r, signal);
    return new Promise<Decision>((resolve) => {
      const entry: PendingRequest = { ask: r, signal, resolve };
      if (signal) {
        entry.onAbort = () => {
          const i = this.requests.indexOf(entry);
          if (i >= 0) this.requests.splice(i, 1);
          resolve({ allow: false, reason: "Cancelled." });
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.requests.push(entry);
    });
  }

  plan(p: PlanUsage, identity?: PlanIdentity) {
    if (this.discarded) return;
    if (this.live) return this.live.plan?.(p, identity);
    this.queue.push({ type: "plan", p, identity });
  }

  limitReached(hit: { resetsAt?: number }) {
    if (this.discarded) return;
    if (this.live) return this.live.limitReached?.(hit);
    this.queue.push({ type: "limitReached", hit });
  }

  rateLimited(hit: { retryAt?: number }) {
    if (this.discarded) return;
    if (this.live) return this.live.rateLimited?.(hit);
    this.queue.push({ type: "rateLimited", hit });
  }

  nativeId(id: string) {
    if (this.discarded) return;
    if (this.live) return this.live.nativeId?.(id);
    this.queue.push({ type: "nativeId", id });
  }

  subagent(s: SubagentStart): Sink {
    if (this.live) return this.live.subagent(s);
    const child = new BufferedSink();
    if (this.discarded) {
      child.discard();
      return child;
    }
    this.children.push(child);
    this.queue.push({ type: "subagent", start: s, child });
    return child;
  }

  ended() {
    if (this.discarded) return;
    if (this.live) return this.live.ended?.();
    this.queue.push({ type: "ended" });
  }

  relayed(nativeId: string) {
    if (this.discarded) return;
    if (this.live) return this.live.relayed?.(nativeId);
    this.queue.push({ type: "relayed", nativeId });
  }

  mainFree() {
    if (this.discarded) return;
    if (this.live) return this.live.mainFree?.();
    this.queue.push({ type: "mainFree" });
  }

  mainChanged() {
    if (this.discarded) return;
    if (this.live) return this.live.mainChanged?.();
    this.queue.push({ type: "mainChanged" });
  }

  /** Replays buffered events into `liveSink` in order, then forwards all future calls directly. */
  commit(liveSink: Sink) {
    if (this.discarded || this.live) return;
    this.live = liveSink;
    while (this.queue.length) {
      const batch = this.queue.splice(0);
      for (const item of batch) {
        switch (item.type) {
          case "cost": liveSink.cost?.(item.report); break;
          case "event": liveSink.event(item.e); break;
          case "state": liveSink.state(item.patch); break;
          case "plan": liveSink.plan?.(item.p, item.identity); break;
          case "limitReached": liveSink.limitReached?.(item.hit); break;
          case "rateLimited": liveSink.rateLimited?.(item.hit); break;
          case "nativeId": liveSink.nativeId?.(item.id); break;
          case "subagent": {
            const childLive = liveSink.subagent(item.start);
            item.child.commit(childLive);
            break;
          }
          case "ended": liveSink.ended?.(); break;
          case "relayed": liveSink.relayed?.(item.nativeId); break;
          case "mainFree": liveSink.mainFree?.(); break;
          case "mainChanged": liveSink.mainChanged?.(); break;
        }
      }
    }
    const pending = this.requests.splice(0);
    for (const req of pending) {
      if (req.signal && req.onAbort) req.signal.removeEventListener("abort", req.onAbort);
      if (req.signal?.aborted) {
        req.resolve({ allow: false, reason: "Cancelled." });
      } else {
        void liveSink.request(req.ask, req.signal).then(req.resolve, () => req.resolve({ allow: false, reason: "Cancelled." }));
      }
    }
  }

  /** Drops all buffered events and resolves pending requests with cancellation. */
  discard() {
    if (this.discarded || this.live) return;
    this.discarded = true;
    this.queue.length = 0;
    for (const child of this.children.splice(0)) child.discard();
    for (const req of this.requests.splice(0)) {
      if (req.signal && req.onAbort) req.signal.removeEventListener("abort", req.onAbort);
      req.resolve({ allow: false, reason: "Cancelled." });
    }
  }
}
