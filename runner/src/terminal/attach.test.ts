import { expect, test } from "bun:test";
import type { RunnerToServer } from "../../../shared/protocol";
import { decodeChunk, encodeChunk } from "../../../shared/wire";
import { Attaches } from "./attach";
import type { Pty, PtyOptions } from "./pty";

/** A PTY the test drives: output by `emit`, exit by `exit`; it records input and sizes. */
export class FakePty implements Pty {
  static all: FakePty[] = [];
  pid = 1;
  written: string[] = [];
  sizes: [number, number][] = [];
  closed = false;
  private done!: (c: number | null) => void;
  exited = new Promise<number | null>((r) => (this.done = r));
  constructor(
    readonly argv: string[],
    readonly opts: PtyOptions,
  ) {
    this.sizes.push([opts.cols!, opts.rows!]);
    FakePty.all.push(this);
  }
  write(d: string | Uint8Array) {
    this.written.push(typeof d === "string" ? d : new TextDecoder().decode(d));
  }
  resize(c: number, r: number) {
    this.sizes.push([c, r]);
  }
  emit(s: string) {
    this.opts.onData(new TextEncoder().encode(s));
  }
  exit(code: number | null = 0) {
    this.opts.onExit?.(code);
    this.done(code);
  }
  close() {
    this.closed = true;
    this.exit(null);
  }
}

function setup(o: { buffered?: number; connected?: boolean } = {}) {
  const frames: RunnerToServer[] = [];
  const exits: string[] = [];
  let buffered = o.buffered ?? 0;
  const a = new Attaches(
    { send: (m) => (o.connected === false ? false : (frames.push(m), true)), buffered: () => buffered },
    { spawn: (argv, opts) => new FakePty(argv, opts), flushMs: 5, onExit: (t) => exits.push(t) },
  );
  return { a, frames, exits, setBuffered: (n: number) => (buffered = n), pty: () => FakePty.all.at(-1)! };
}

const text = (frames: RunnerToServer[]) => frames.filter((f) => f.t === "term").map((f) => new TextDecoder().decode(decodeChunk((f as any).data))).join("");

test("output is coalesced into frames for that attach only; input and resize reach its PTY", async () => {
  const { a, frames, pty } = setup();
  a.open("a1", "t-x", ["tmux", "attach"], 100, 30);
  const p = pty();
  expect(p.argv).toEqual(["tmux", "attach"]);
  expect(p.sizes).toEqual([[100, 30]]);
  p.emit("hel");
  p.emit("lo ✻");
  expect(frames).toEqual([]);
  await Bun.sleep(20);
  expect(frames.length).toBe(1);
  expect(frames[0]).toMatchObject({ t: "term", attachId: "a1" });
  expect(text(frames)).toBe("hello ✻");
  a.input("a1", new TextEncoder().encode("ls\r"));
  expect(p.written).toEqual(["ls\r"]);
  a.resize("a1", 40, 0);
  expect(p.sizes.at(-1)).toEqual([40, 24]);
  expect(a.of("t-x")).toEqual(["a1"]);
  expect(() => a.input("nope", new Uint8Array())).toThrow(/isn't attached/);
});

test("a PTY that exits by itself ends its attach with termEnd and reports its target", async () => {
  const { a, frames, exits, pty } = setup();
  a.open("a1", "t-x", ["x"], 80, 24);
  pty().emit("bye");
  pty().exit(0);
  expect(text(frames)).toBe("bye");
  expect(frames.at(-1)).toEqual({ t: "termEnd", attachId: "a1", reason: "exited" });
  expect(exits).toEqual(["t-x"]);
  expect(a.size).toBe(0);
});

test("closing (the browser left) ends the PTY quietly", () => {
  const { a, frames, exits, pty } = setup();
  a.open("a1", "t-x", ["x"], 80, 24);
  a.close("a1");
  expect(pty().closed).toBe(true);
  expect(frames).toEqual([]);
  expect(exits).toEqual([]);
});

test("a session that is gone ends every attach of it, with a reason", () => {
  const { a, frames } = setup();
  a.open("a1", "t-x", ["x"], 80, 24);
  a.open("a2", "t-x", ["x"], 40, 20);
  a.open("a3", "t-y", ["x"], 80, 24);
  a.endTarget("t-x", "exited");
  expect(frames).toEqual([
    { t: "termEnd", attachId: "a1", reason: "exited" },
    { t: "termEnd", attachId: "a2", reason: "exited" },
  ]);
  expect(a.of("t-y")).toEqual(["a3"]);
});

test("an attach whose connection falls far behind ends instead of dropping output", async () => {
  const { a, frames, pty, setBuffered } = setup();
  a.open("a1", "t-x", ["x"], 80, 24);
  setBuffered(100 * 1024 * 1024);
  pty().emit("lots");
  await Bun.sleep(20);
  expect(frames).toEqual([{ t: "termEnd", attachId: "a1", reason: "too slow" }]);
  expect(pty().closed).toBe(true);
});

test("with no connection the attach is dropped (the relay forgot it)", async () => {
  const { a, pty } = setup({ connected: false });
  a.open("a1", "t-x", ["x"], 80, 24);
  pty().emit("x");
  await Bun.sleep(20);
  expect(a.has("a1")).toBe(false);
});

test("a big burst goes out at once, in order", () => {
  const { a, frames, pty } = setup();
  a.open("a1", "t-x", ["x"], 80, 24);
  const big = "x".repeat(70 * 1024);
  pty().emit(big);
  pty().emit("tail");
  expect(text(frames)).toBe(big);
});
