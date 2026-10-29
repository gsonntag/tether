import { expect, test } from "bun:test";
import type { ServerToBrowser } from "../../shared/protocol";
import { encodeChunk } from "../../shared/wire";
import { handoffPrompt, TermConn, type TermDeps } from "./terminal";

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

test("the prompt before handing off", () => {
  expect(handoffPrompt(false, 0)).toBeNull();
  expect(handoffPrompt(true, 0)).toEqual({ text: "Stop this turn and open the terminal?", confirm: "Stop and open terminal" });
  expect(handoffPrompt(true, 2)?.text).toBe("Stop this turn and open the terminal? 2 queued messages will wait until you're back.");
  expect(handoffPrompt(false, 1)).toEqual({ text: "Open the terminal? 1 queued message will wait until you're back.", confirm: "Open terminal" });
});
