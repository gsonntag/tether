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
