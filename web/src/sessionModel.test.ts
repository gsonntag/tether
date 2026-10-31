import { expect, test } from "bun:test";
import type { LiveState, Msg, SessionEvent, SessionSnapshot } from "../../shared/transcript";
import { SessionModel } from "./sessionModel";

const msg = (id: string, text = id): Msg => ({ id, role: "assistant", ts: 0, parts: [{ type: "text", text }] });
const state: LiveState = { mode: "live", status: "idle", requests: [], queue: [] };
const snap = (seq: number, ids: string[]): SessionSnapshot => ({
  session: { id: "claude:1", harness: "claude", nativeId: "1", projectPath: "/p", title: "t", mode: "live", status: "idle", updatedAt: 0 },
  capabilities: { canSteer: true, terminal: "handoff", subagents: { view: true, stop: true, steer: false } },
  messages: ids.map((i) => msg(i)),
  hasOlder: false,
  state,
  seq,
});
const append = (id: string): SessionEvent => ({ type: "msg", msg: msg(id), isNew: true });
const ids = (m: SessionModel) => m.view.window!.messages.map((x) => x.id);

test("events before the snapshot are buffered; those the snapshot holds are dropped", () => {
  const m = new SessionModel();
  m.subscribing();
  expect(m.onEvent(5, append("a"))).toBe("ok");
  expect(m.onEvent(6, append("b"))).toBe("ok");
  expect(m.view.window).toBeUndefined();
  expect(m.onSnapshot(snap(5, ["x", "a"]))).toBe("ok");
  expect(ids(m)).toEqual(["x", "a", "b"]);
  expect(m.seq).toBe(6);
});

test("in-order events apply, stale ones are ignored, a gap asks for a fresh snapshot", () => {
  const m = new SessionModel();
  m.onSnapshot(snap(1, ["a"]));
  expect(m.onEvent(2, append("b"))).toBe("ok");
  expect(m.onEvent(2, append("dup"))).toBe("ok");
  expect(ids(m)).toEqual(["a", "b"]);
  expect(m.onEvent(4, append("d"))).toBe("refresh");
  // Nothing applies until the fresh snapshot, but the view stays.
  expect(m.onEvent(5, append("e"))).toBe("ok");
  expect(ids(m)).toEqual(["a", "b"]);
  m.subscribing();
  m.onEvent(6, append("f"));
  expect(m.onSnapshot(snap(5, ["a", "b", "c", "d", "e"]))).toBe("ok");
  expect(ids(m)).toEqual(["a", "b", "c", "d", "e", "f"]);
});

test("a buffered gap after the snapshot asks again", () => {
  const m = new SessionModel();
  m.subscribing();
  m.onEvent(9, append("z"));
  expect(m.onSnapshot(snap(5, ["a"]))).toBe("refresh");
});

test("resync asks for a fresh snapshot; state events patch the state", () => {
  const m = new SessionModel();
  m.onSnapshot(snap(1, ["a"]));
  expect(m.onEvent(2, { type: "state", state: { status: "running" } })).toBe("ok");
  expect(m.view.state).toMatchObject({ status: "running", mode: "live" });
  m.onEvent(3, { type: "state", state: { error: "x" } });
  m.onEvent(4, { type: "state", state: { error: null } as any });
  expect("error" in m.view.state!).toBe(false);
  expect(m.onEvent(5, { type: "resync" })).toBe("refresh");
});

test("a runner that restarted: old buffered events never block the new snapshot", () => {
  const m = new SessionModel();
  m.onSnapshot(snap(100, ["a"]));
  m.onEvent(101, append("b"));
  m.subscribing();
  expect(m.onSnapshot(snap(0, ["a", "b"]))).toBe("ok");
  expect(m.onEvent(1, append("c"))).toBe("ok");
  expect(ids(m)).toEqual(["a", "b", "c"]);
});

test("older pages go in front; a failed first subscribe shows an error", () => {
  const m = new SessionModel();
  m.onError(new Error("That runner is offline."));
  expect(m.view.error).toBe("That runner is offline.");
  m.onSnapshot({ ...snap(1, ["c"]), hasOlder: true });
  m.prepend({ messages: [msg("a"), msg("b")], hasOlder: false });
  expect(ids(m)).toEqual(["a", "b", "c"]);
  expect(m.view.window!.hasOlder).toBe(false);
  m.onError(new Error("later"));
  expect(m.view.error).toBeUndefined();
});

const paged = (seq: number, ids: string[]): SessionSnapshot => ({ ...snap(seq, ids), hasOlder: true });
const page = (ids: string[], hasOlder = true) => ({ messages: ids.map((i) => msg(i)), hasOlder });
/** a window of a..e with older pages loaded in front */
const loaded = () => {
  const m = new SessionModel();
  m.onSnapshot(paged(1, ["c", "d", "e"]));
  m.prepend(page(["a", "b"]));
  return m;
};

test("a reconnect's snapshot keeps the older pages loaded, with nothing doubled", () => {
  const m = loaded();
  m.subscribing();
  m.onSnapshot(paged(9, ["d", "e", "f"]));
  expect(ids(m)).toEqual(["a", "b", "c", "d", "e", "f"]);
  expect(m.view.window!.hasOlder).toBe(true);
  // the snapshot's copy of a message wins
  m.subscribing();
  m.onSnapshot({ ...paged(10, ["e", "f"]), messages: [msg("e", "new"), msg("f")] });
  expect((m.view.window!.messages[4]!.parts[0] as { text: string }).text).toBe("new");
});

test("a snapshot after a rewind drops what the rewind dropped, and a whole transcript is simply it", () => {
  const m = loaded();
  m.onSnapshot(paged(9, ["c", "x"]));
  expect(ids(m)).toEqual(["a", "b", "c", "x"]);
  m.onSnapshot(snap(10, ["p", "q"]));
  expect(ids(m)).toEqual(["p", "q"]);
  expect(m.view.window!.hasOlder).toBe(false);
});

test("a snapshot past what's loaded: a gap the store closes page by page, the reader's rows staying", () => {
  const m = loaded();
  m.onSnapshot(paged(9, ["x", "y"]));
  expect(ids(m)).toEqual(["a", "b", "c", "d", "e", "x", "y"]);
  expect(m.gapBefore).toBe("x");
  m.onEvent(10, append("z"));
  m.fillGap("x", page(["g", "h"]));
  expect(ids(m)).toEqual(["a", "b", "c", "d", "e", "g", "h", "x", "y", "z"]);
  expect(m.gapBefore).toBe("g");
  m.fillGap("stale", page(["nope"]));
  m.fillGap("g", page(["d", "e", "f"]));
  expect(ids(m)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "x", "y", "z"]);
  expect(m.gapBefore).toBeUndefined();
});

test("a gap that can't be closed gives up what's behind it, never the newest", () => {
  const failed = loaded();
  failed.onSnapshot(paged(9, ["x", "y"]));
  failed.fillGap("x");
  expect(ids(failed)).toEqual(["x", "y"]);
  expect(failed.view.window!.hasOlder).toBe(true);
  // the session's start reached without meeting: a different history
  const other = loaded();
  other.onSnapshot(paged(9, ["x", "y"]));
  other.fillGap("x", page(["w"], false));
  expect(ids(other)).toEqual(["w", "x", "y"]);
  expect(other.view.window!.hasOlder).toBe(false);
  // too far: bounded
  const far = loaded();
  far.onSnapshot(paged(9, ["x0"]));
  for (let i = 0; far.gapBefore; i++) far.fillGap(far.gapBefore, page([`x${i + 1}`]));
  expect(ids(far).slice(0, 2)).toEqual(["x10", "x9"]);
});

test("a second snapshot while a gap is open starts from what was loaded", () => {
  const m = loaded();
  m.onSnapshot(paged(9, ["x", "y"]));
  m.fillGap("x", page(["g"]));
  m.onSnapshot(paged(12, ["y", "z"]));
  expect(ids(m)).toEqual(["a", "b", "c", "d", "e", "y", "z"]);
  expect(m.gapBefore).toBe("y");
});
