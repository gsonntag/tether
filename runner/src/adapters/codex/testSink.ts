// A sink for adapter tests: keeps a transcript as the core would, the states it was told, the
// requests it was asked, and the subagent sinks it opened.

import type { LiveState } from "../../../../shared/transcript";
import type { Decision, RequestAsk, Sink, SubagentStart } from "../../core/adapter";
import { Transcript } from "../../core/transcript";

export class TestSink implements Sink {
  t = new Transcript();
  states: Partial<LiveState>[] = [];
  asks: { ask: RequestAsk; signal?: AbortSignal; resolve: (d: Decision) => void }[] = [];
  children = new Map<string, TestSink>();
  starts: SubagentStart[] = [];
  endedCount = 0;

  event(e: Parameters<Sink["event"]>[0]) {
    this.t.apply(e);
  }
  message(id: string) {
    return this.t.get(id);
  }
  state(patch: Partial<LiveState>) {
    this.states.push(patch);
  }
  get status() {
    return this.states.filter((s) => s.status).at(-1)?.status;
  }
  request(ask: RequestAsk, signal?: AbortSignal): Promise<Decision> {
    return new Promise((resolve) => {
      this.asks.push({ ask, signal, resolve });
      signal?.addEventListener("abort", () => resolve({ allow: false, reason: "aborted" }));
    });
  }
  subagent(s: SubagentStart): Sink {
    this.starts.push(s);
    let c = this.children.get(s.nativeId);
    if (!c) this.children.set(s.nativeId, (c = new TestSink()));
    return c;
  }
  ended() {
    this.endedCount++;
  }
}

/** A recorded daemon stream: one JSON message per line. */
export async function frames(name: string): Promise<any[]> {
  const text = await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export async function fixture(name: string): Promise<any> {
  return Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).json();
}

/** A message without what live and stored legitimately differ in (time, streaming). */
export const comparable = (m: any) => {
  const { ts: _t, streaming: _s, ...rest } = m;
  return rest;
};
