import { expect, test } from "bun:test";
import type { ServerToBrowser } from "../../shared/protocol";
import { decodeChunk, encodeChunk } from "../../shared/wire";
import { handoffPrompt, shellOpened, TermConn, type TermDeps } from "./terminal";

/** A relay and runner in miniature: records rpcs, answers openTerminal with fresh attach ids. */
function fake() {
  const calls: { op: string; args: any }[] = [];
  const handlers = new Map<string, ((m: any) => void)[]>();
  const link: ((o: boolean) => void)[] = [];
  const runner: (() => void)[] = [];
  let n = 0;
  let open = true;
  let online = true;
  let fail: string | undefined;
  /** frames to send before openTerminal answers (output the relay routes early) */
  let before: string | undefined;
  const emit = (m: ServerToBrowser) => handlers.get(m.t)?.forEach((f) => f(m));
  const deps: TermDeps = {
    rpc: (async (_r: string, op: string, args: any) => {
      calls.push({ op, args });
      if (op !== "openTerminal") return null;
      if (fail) throw new Error(fail);
      const attachId = `a${++n}`;
      if (before) emit({ t: "term", attachId, data: encodeChunk(new TextEncoder().encode(before)) });
      return { attachId, target: "t" };
    }) as any,
    on: ((t: string, f: any) => {
      handlers.set(t, [...(handlers.get(t) ?? []), f]);
      return () => {};
    }) as any,
    linkOpen: () => open,
    onLink: (f) => (link.push(f), () => link.splice(link.indexOf(f), 1)),
    runnerOnline: () => online,
    onRunner: (f) => (runner.push(f), () => runner.splice(runner.indexOf(f), 1)),
  };
  return {
    deps,
    calls,
    emit,
    setLink: (o: boolean) => ((open = o), link.forEach((f) => f(o))),
    setRunner: (o: boolean) => ((online = o), runner.forEach((f) => f())),
    failWith: (e?: string) => (fail = e),
    early: (s?: string) => (before = s),
  };
}

function view() {
  const out: string[] = [];
  const statuses: string[] = [];
  let resets = 0;
  return {
    cb: { data: (b: Uint8Array) => out.push(new TextDecoder().decode(b)), reset: () => resets++, status: (s: string, why?: string) => statuses.push(why ? `${s}: ${why}` : s) },
    out,
    statuses,
    resets: () => resets,
  };
}

const tick = () => Bun.sleep(1);

test("attaches, gets output for its attach only (early output included), types and resizes", async () => {
  const f = fake();
  const v = view();
  f.early("early ");
  const c = new TermConn("r1", { sessionId: "claude:s" }, v.cb, f.deps);
  await c.open(120, 40, true);
  expect(f.calls[0]).toEqual({ op: "openTerminal", args: { sessionId: "claude:s", cols: 120, rows: 40, stop: true } });
  f.emit({ t: "term", attachId: c.attachId!, data: encodeChunk(new TextEncoder().encode("hi")) });
  f.emit({ t: "term", attachId: "other", data: encodeChunk(new TextEncoder().encode("not mine")) });
  expect(v.out.join("")).toBe("early hi");
  c.input("ls\r");
  expect(f.calls.at(-1)).toEqual({ op: "terminalInput", args: { attachId: c.attachId, data: encodeChunk(new TextEncoder().encode("ls\r")) } });
  c.resize(50, 20);
  await Bun.sleep(80);
  expect(f.calls.at(-1)).toEqual({ op: "terminalResize", args: { attachId: c.attachId, cols: 50, rows: 20 } });
  expect(v.statuses).toEqual(["connecting", "open"]);
  c.close();
  expect(f.calls.at(-1)).toEqual({ op: "closeTerminal", args: { attachId: "a1" } });
});

test("a resize while the attach is on its way reaches the PTY once it's there", async () => {
  const f = fake();
  const c = new TermConn("r1", { sessionId: "claude:s" }, view().cb, f.deps);
  const opening = c.open(73, 50);
  // The panel's first fit, before openTerminal answers.
  c.resize(74, 50);
  await opening;
  await Bun.sleep(80);
  expect(f.calls[0]!.args).toMatchObject({ cols: 73, rows: 50 });
  expect(f.calls.filter((x) => x.op === "terminalResize")).toEqual([{ op: "terminalResize", args: { attachId: c.attachId, cols: 74, rows: 50 } }]);
  c.close();
});

test("a resize long before a slow attach answers isn't lost either", async () => {
  const f = fake();
  const rpc = f.deps.rpc;
  f.deps.rpc = (async (r: string, op: string, args: any) => {
    if (op === "openTerminal") await Bun.sleep(150);
    return (rpc as any)(r, op, args);
  }) as any;
  const c = new TermConn("r1", { sessionId: "claude:s" }, view().cb, f.deps);
  const opening = c.open(73, 50);
  c.resize(74, 50);
  await opening;
  await Bun.sleep(80);
  expect(f.calls.filter((x) => x.op === "terminalResize")).toEqual([{ op: "terminalResize", args: { attachId: c.attachId, cols: 74, rows: 50 } }]);
  c.close();
});

test("a dropped link reattaches (reattach only) when it's back, and the screen starts over", async () => {
  const f = fake();
  const v = view();
  const c = new TermConn("r1", { shellId: "sh-1" }, v.cb, f.deps);
  await c.open(80, 24);
  f.setLink(false);
  expect(c.status).toBe("reconnecting");
  f.setLink(true);
  await tick();
  expect(f.calls.at(-1)).toEqual({ op: "openTerminal", args: { shellId: "sh-1", cols: 80, rows: 24, reattach: true } });
  expect(c.attachId).toBe("a2");
  expect(v.resets()).toBe(1);
  expect(c.status).toBe("open");
});

test("the runner going away ends the attach; it comes back when the runner does", async () => {
  const f = fake();
  const v = view();
  const c = new TermConn("r1", { sessionId: "claude:s" }, v.cb, f.deps);
  await c.open(80, 24);
  f.setRunner(false);
  f.emit({ t: "termEnd", attachId: "a1", reason: "The runner disconnected." });
  expect(c.status).toBe("reconnecting");
  expect(f.calls.length).toBe(1);
  f.setRunner(true);
  await tick();
  expect(c.attachId).toBe("a2");
});

test("a terminal that exited ends for good; one that exited while away is not started again", async () => {
  const f = fake();
  const v = view();
  const c = new TermConn("r1", { sessionId: "claude:s" }, v.cb, f.deps);
  await c.open(80, 24);
  f.emit({ t: "termEnd", attachId: "a1", reason: "exited" });
  expect(c.status).toBe("ended");
  f.setLink(false);
  f.setLink(true);
  await tick();
  expect(f.calls.length).toBe(1);

  const d = new TermConn("r1", { sessionId: "claude:t" }, view().cb, f.deps);
  await d.open(80, 24);
  f.setLink(false);
  f.failWith("That terminal has closed.");
  f.setLink(true);
  await tick();
  expect(d.status).toBe("ended");
});

test("opened while the runner is away, it attaches when the runner is back", async () => {
  const f = fake();
  const v = view();
  f.setRunner(false);
  const c = new TermConn("r1", { sessionId: "claude:s" }, v.cb, f.deps);
  await c.open(90, 30, true);
  expect(f.calls).toEqual([]);
  expect(c.status).toBe("reconnecting");
  f.setRunner(true);
  await tick();
  expect(f.calls[0]).toEqual({ op: "openTerminal", args: { sessionId: "claude:s", cols: 90, rows: 30, stop: true } });
  expect(c.status).toBe("open");
});

test("the first attach's error reaches the caller (the busy prompt's race)", async () => {
  const f = fake();
  f.failWith("A turn is running. Stop it to open the terminal.");
  const c = new TermConn("r1", { sessionId: "claude:s" }, view().cb, f.deps);
  await expect(c.open(80, 24)).rejects.toThrow(/turn is running/);
});

test("a swipe is wheel notches: a tap isn't, the finger down goes to older lines, and it glides only if still moving", async () => {
  const { Swipe, wheelSeq } = await import("./terminal");
  expect(wheelSeq(true, 2)).toBe("\x1b[<64;1;1M\x1b[<64;1;1M");
  expect(wheelSeq(false)).toBe("\x1b[<65;1;1M");
  const s = new Swipe(10);
  s.start(100, 0);
  expect(s.move(104, 10)).toBe(0); // a tap's wobble
  expect(s.active).toBe(false);
  expect(s.release(20)).toBe(0);
  s.start(100, 0);
  expect(s.move(125, 10)).toBe(2);
  expect(s.move(130, 20)).toBe(1); // the half line carried over
  expect(s.move(110, 30)).toBe(-2);
  expect(s.release(40)).toBeLessThan(0);
  expect(s.release(500)).toBe(0);
});

test("keys typed during a reattach go out when it's back", async () => {
  const f = fake();
  const c = new TermConn("r", { shellId: "s" }, { data: () => {}, reset: () => {}, status: () => {} }, f.deps);
  await c.open(80, 24);
  const id = c.attachId!;
  c.onEnd("gone");
  c.input("ab");
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  expect(c.attachId).toBeDefined();
  expect(c.attachId).not.toBe(id);
  const sent = f.calls.filter((x) => x.op === "terminalInput");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.args.attachId).toBe(c.attachId);
  c.close();
});

const typed = (f: ReturnType<typeof fake>) => f.calls.filter((c) => c.op === "terminalInput").map((c) => ({ id: c.args.attachId, text: new TextDecoder().decode(decodeChunk(c.args.data)), leave: c.args.leave, swipe: c.args.swipe }));

test("a line goes to the terminal it was typed for, Enter too, even if another comes to the front meanwhile", async () => {
  const f = fake();
  const c = new TermConn("r1", { shellId: "s1" }, view().cb, f.deps);
  await c.open(80, 24);
  c.line("ls");
  expect(typed(f)).toEqual([{ id: "a1", text: "ls", leave: true, swipe: undefined }]);
  // The view moves on: the attach stays until its Enter is out, then closes.
  c.close();
  expect(f.calls.some((x) => x.op === "closeTerminal")).toBe(false);
  await Bun.sleep(200);
  expect(typed(f).at(-1)).toEqual({ id: "a1", text: "\r", leave: true, swipe: undefined });
  expect(f.calls.some((x) => x.op === "closeTerminal")).toBe(false);
  await Bun.sleep(200);
  expect(f.calls.at(-1)?.op).toBe("closeTerminal");
});

test("two lines in a row keep their order", async () => {
  const f = fake();
  const c = new TermConn("r1", { shellId: "s1" }, view().cb, f.deps);
  await c.open(80, 24);
  c.line("one");
  c.line("two");
  await Bun.sleep(200);
  expect(typed(f).map((k) => k.text)).toEqual(["one", "\r", "two", "\r"]);
  c.close();
});

test("a swipe says it's a swipe; a key held through a reattach keeps what it asked for", async () => {
  const f = fake();
  const c = new TermConn("r1", { shellId: "s1" }, view().cb, f.deps);
  await c.open(80, 24);
  c.swipe(-2);
  expect(typed(f)).toEqual([{ id: "a1", text: "\x1b[<65;1;1M\x1b[<65;1;1M", leave: undefined, swipe: true }]);
  f.setLink(false);
  c.input("\x1b[A", true);
  c.swipe(3); // not kept: gone with the moment
  f.setLink(true);
  await Bun.sleep(0);
  expect(typed(f).at(-1)).toEqual({ id: "a2", text: "\x1b[A", leave: true, swipe: undefined });
  expect(typed(f).length).toBe(2);
  c.close();
});

test("a reattach that fails tries again, then keeps trying at a capped pace; a closed terminal ends it", async () => {
  const f = fake();
  const v = view();
  const c = new TermConn("r1", { shellId: "s1" }, v.cb, f.deps);
  await c.open(80, 24);
  const realSet = globalThis.setTimeout;
  const delays: number[] = [];
  const timers: (() => void)[] = [];
  (globalThis as any).setTimeout = (fn: () => void, ms: number) => (ms >= 1000 ? (delays.push(ms), timers.push(fn), 1) : realSet(fn, ms));
  try {
    f.failWith("The runner is busy.");
    f.setLink(false);
    f.setLink(true);
    for (let i = 0; i < 7; i++) {
      await Bun.sleep(0);
      timers.shift()?.();
    }
    await Bun.sleep(0);
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000]);
    expect(c.status).toBe("reconnecting");
    f.failWith(undefined);
    timers.shift()?.();
    await Bun.sleep(0);
    expect(c.status).toBe("open");
    expect(timers).toEqual([]);
  } finally {
    globalThis.setTimeout = realSet;
    c.close();
  }
});

test("a close during the backoff stops the tries", async () => {
  const f = fake();
  const c = new TermConn("r1", { shellId: "s1" }, view().cb, f.deps);
  await c.open(80, 24);
  f.failWith("The runner is busy.");
  f.setLink(false);
  f.setLink(true);
  await Bun.sleep(0);
  c.close();
  const n = f.calls.filter((x) => x.op === "openTerminal").length;
  await Bun.sleep(1100);
  expect(f.calls.filter((x) => x.op === "openTerminal").length).toBe(n);
});

test("the prompt before handing off, with the queue paused", () => {
  expect(handoffPrompt(true, 2, true)?.text).toBe("Stop this turn and open the terminal? The 2 queued messages stay paused.");
  expect(handoffPrompt(false, 1, true)).toBeNull();
});

test("the prompt before handing off", () => {
  expect(handoffPrompt(false, 0)).toBeNull();
  expect(handoffPrompt(true, 0)).toEqual({ text: "Stop this turn and open the terminal?", confirm: "Stop and open terminal" });
  expect(handoffPrompt(true, 2)?.text).toBe("Stop this turn and open the terminal? 2 queued messages will wait until you're back.");
  expect(handoffPrompt(false, 1)).toEqual({ text: "Open the terminal? 1 queued message will wait until you're back.", confirm: "Open terminal" });
});

test("a shell that finishes opening never takes you off the agent's entry", () => {
  const waiting = { tab: "shell", wantTui: false };
  const moved = { tab: "tui", wantTui: true };
  expect(shellOpened(waiting, "sh-1", true)).toEqual({ tab: "sh-1", wantTui: false });
  expect(shellOpened(moved, "sh-1", true)).toBe(moved);
  // + New shell, asked for: it comes to the front from anywhere.
  expect(shellOpened(moved, "sh-1", false)?.tab).toBe("sh-1");
  // The panel was closed meanwhile.
  expect(shellOpened(null, "sh-1", true)).toBeNull();
});
