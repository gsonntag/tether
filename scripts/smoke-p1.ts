// A scripted browser against a local dev stack (server :8790 + runner): drives real Claude through
// the relay and checks what comes back. Not part of `bun test` (it spends real model turns).
//   bun scripts/smoke-p1.ts [scenario…]   scenarios: reply interrupt subagent restart-wait
//
// Uses Haiku in a scratch project under ~/.local/share/tether-dev/projects/scratch.

import { applyToWindow, type TranscriptWindow } from "../shared/window";
import type { Msg, SessionEvent, SessionSnapshot } from "../shared/transcript";

const URL = process.env.TETHER_WS ?? "ws://127.0.0.1:8790/api/ws";
const RUNNER = process.env.TETHER_RUNNER ?? "tether-dev";
const PROJECT = process.env.SCRATCH ?? `${process.env.HOME}/.local/share/tether-dev/projects/scratch`;

class Browser {
  ws!: WebSocket;
  private n = 0;
  private pending = new Map<string, { ok: (v: any) => void; fail: (e: Error) => void }>();
  events: { sessionId: string; seq: number; event: SessionEvent }[] = [];
  summaries: any[] = [];
  open(): Promise<void> {
    return new Promise((ok, fail) => {
      this.ws = new WebSocket(URL);
      this.ws.onopen = () => ok();
      this.ws.onerror = () => fail(new Error("socket error"));
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.t === "result") {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.ok ? p?.ok(m.data) : p?.fail(new Error(m.error));
        } else if (m.t === "event") this.events.push(m);
        else if (m.t === "summary") this.summaries.push(m.summary);
      };
    });
  }
  rpc<T = any>(op: string, args: object = {}): Promise<T> {
    const id = String(++this.n);
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail });
      this.ws.send(JSON.stringify({ t: "rpc", id, runnerId: RUNNER, op, args }));
    });
  }
  close() {
    this.ws.close();
  }
}

/** A subscriber's view: snapshot, then events by seq. */
class View {
  w: TranscriptWindow;
  seq: number;
  state: any;
  constructor(snap: SessionSnapshot) {
    this.w = { messages: snap.messages, hasOlder: snap.hasOlder };
    this.seq = snap.seq;
    this.state = snap.state;
  }
  fold(b: Browser, sessionId: string) {
    for (const e of b.events.filter((x) => x.sessionId === sessionId)) {
      if (e.seq <= this.seq) continue;
      if (e.seq !== this.seq + 1) throw new Error(`gap ${this.seq} -> ${e.seq}`);
      this.seq = e.seq;
      this.w = applyToWindow(this.w, e.event);
      if (e.event.type === "state") this.state = { ...this.state, ...e.event.state };
    }
  }
}

async function until(cond: () => boolean, ms: number, what: string) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await Bun.sleep(100);
  }
}

const text = (m: Msg) => m.parts.map((p) => (p.type === "tool" ? `[${p.name} ${p.status}${p.childSessionId ? ` -> ${p.childSessionId}` : ""}]` : p.type === "thinking" ? `(thinking ${p.text.length})` : p.type === "text" ? p.text : "[image]")).join(" ");
const show = (v: View) => v.w.messages.map((m) => `  ${m.role.padEnd(9)} ${text(m).replace(/\s+/g, " ").slice(0, 140)}`).join("\n");

async function newSession(b: Browser) {
  const { sessionId } = await b.rpc("newSession", { harness: "claude", projectPath: PROJECT, model: "haiku", permissionMode: "bypassPermissions" });
  return sessionId as string;
}

async function waitIdle(b: Browser, v: View, id: string, ms = 120_000) {
  await until(() => (v.fold(b, id), v.state.status === "idle" && v.w.messages.some((m) => m.role === "assistant")), ms, `idle ${id}`);
}

const scenarios: Record<string, () => Promise<void>> = {
  async reply() {
    const a = new Browser();
    const b = new Browser();
    await a.open();
    await b.open();
    const id = await newSession(a);
    console.log("new session", id);
    const va = new View(await a.rpc("subscribe", { sessionId: id }));
    await a.rpc("send", { sessionId: id, text: "Reply with exactly: pong. Then read README.md with the Read tool and quote its first line." });
    await Bun.sleep(1500);
    // The second device joins mid-turn.
    const vb = new View(await b.rpc("subscribe", { sessionId: id }));
    await waitIdle(a, va, id);
    await until(() => (vb.fold(b, id), vb.state.status === "idle"), 30_000, "b idle");
    console.log(show(va));
    if (JSON.stringify(va.w) !== JSON.stringify(vb.w)) throw new Error("the two devices differ");
    const deltas = a.events.filter((e) => e.sessionId === id && e.event.type === "delta").length;
    console.log(`ok: both devices identical (${va.w.messages.length} messages, ${deltas} deltas streamed), state`, va.state);
    // A fresh snapshot equals what the events built.
    const fresh = new View(await a.rpc("subscribe", { sessionId: id }));
    if (JSON.stringify(fresh.w.messages) !== JSON.stringify(va.w.messages)) throw new Error("fresh snapshot differs from the streamed transcript");
    console.log("ok: a fresh snapshot equals the streamed transcript");
    const models = await a.rpc("listModels", { harness: "claude", sessionId: id });
    console.log("models:", models.models.map((m: any) => m.label).join(", "));
    a.close();
    b.close();
  },
  async interrupt() {
    const a = new Browser();
    await a.open();
    const id = await newSession(a);
    const v = new View(await a.rpc("subscribe", { sessionId: id }));
    await a.rpc("send", { sessionId: id, text: "Write a 600-word story about a lighthouse. No tools." });
    await until(() => (v.fold(a, id), v.w.messages.some((m) => m.role === "assistant" && text(m).length > 40)), 60_000, "streaming");
    await a.rpc("interrupt", { sessionId: id });
    await until(() => (v.fold(a, id), v.state.status === "idle"), 30_000, "idle after interrupt");
    console.log(show(v));
    if (!v.w.messages.some((m) => m.role === "notice" && text(m) === "Interrupted")) throw new Error("no Interrupted notice");
    console.log("ok: interrupted");
    a.close();
  },
  async subagent() {
    const a = new Browser();
    await a.open();
    const id = await newSession(a);
    const v = new View(await a.rpc("subscribe", { sessionId: id }));
    await a.rpc("send", { sessionId: id, text: "Use the Agent tool (general-purpose subagent) to count the lines of README.md and math.ts with Bash wc -l. Then tell me the total in one sentence." });
    let child: string | undefined;
    await until(() => {
      v.fold(a, id);
      child = v.w.messages.flatMap((m) => m.parts).find((p: any) => p.type === "tool" && p.childSessionId)?.["childSessionId" as never];
      return !!child;
    }, 90_000, "child link");
    console.log("child", child);
    const cv = new View(await a.rpc("subscribe", { sessionId: child }));
    console.log("child state at open:", cv.state.status, cv.state.mode);
    await waitIdle(a, v, id, 180_000);
    cv.fold(a, child!);
    console.log("parent:\n" + show(v));
    console.log("child:\n" + show(cv));
    const kids = await a.rpc("listSessions", { parentSessionId: id });
    console.log("children listed:", kids.sessions.map((s: any) => `${s.id} ${s.status}`));
    if (!cv.w.messages.some((m) => m.parts.some((p) => p.type === "tool" && p.name === "Bash"))) throw new Error("child has no Bash call");
    console.log("ok: subagent child session");
    a.close();
  },
};

const pick = process.argv.slice(2);
for (const name of pick.length ? pick : ["reply", "interrupt", "subagent"]) {
  console.log(`\n== ${name}`);
  await scenarios[name]!();
}
process.exit(0);
