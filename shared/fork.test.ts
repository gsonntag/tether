import { describe, expect, test } from "bun:test";
import { forkPoints, forkTitle, wholeForkPoint } from "./fork";
import type { Msg } from "./transcript";

const user = (id: string, text = "q"): Msg => ({ id, role: "user", ts: 1, parts: [{ type: "text", text }] });
const reply = (id: string, text = "a"): Msg => ({ id, role: "assistant", ts: 2, parts: [{ type: "text", text }] });
const calling = (id: string): Msg => ({ id, role: "assistant", ts: 2, parts: [{ type: "text", text: "Looking" }, { type: "tool", id: "t", name: "bash", kind: "shell", input: {}, status: "done" }] });
const notice = (id: string): Msg => ({ id, role: "notice", level: "info", ts: 3, parts: [{ type: "text", text: "Context compacted." }] });

describe("fork points", () => {
  test("the reply that ends each finished turn", () => {
    const msgs = [user("u1"), calling("a1"), reply("a2"), user("u2"), reply("a3")];
    expect([...forkPoints(msgs, false)].sort()).toEqual(["a2", "a3"]);
  });
  test("a reply ending on a tool call, an error or a stream isn't one", () => {
    const msgs = [user("u1"), calling("a1"), user("u2"), { ...reply("a2"), error: "boom" }, user("u3"), { ...reply("a3"), streaming: true }];
    expect([...forkPoints(msgs, false)]).toEqual([]);
  });
  test("notices between a reply and the next prompt don't matter", () => {
    expect([...forkPoints([user("u1"), reply("a1"), notice("n1"), user("u2"), reply("a2"), notice("n2")], false)].sort()).toEqual(["a1", "a2"]);
  });
  test("while a turn runs, nothing after the latest prompt counts", () => {
    const msgs = [user("u1"), reply("a1"), user("u2"), reply("a2")];
    expect([...forkPoints(msgs, true)]).toEqual(["a1"]);
    expect([...forkPoints([user("u1"), reply("a1"), user("u2")], true)]).toEqual(["a1"]);
  });
  test("a message cut short to travel counts by its place: the runner checks it whole", () => {
    expect([...forkPoints([user("u1"), { ...calling("a1"), partsOmitted: 3 }], false)]).toEqual(["a1"]);
  });
  test("forking the whole session: everything when idle, else the last finished turn", () => {
    expect(wholeForkPoint([user("u1"), reply("a1")], false)).toEqual({});
    expect(wholeForkPoint([user("u1"), reply("a1"), user("u2"), calling("a2")], true)).toEqual({ upTo: "a1" });
    expect(wholeForkPoint([user("u1")], true)).toBeUndefined();
    expect(wholeForkPoint([notice("n")], false)).toBeUndefined();
  });
  test("titles", () => {
    expect(forkTitle("Fix the build")).toBe("Fix the build (fork)");
    expect(forkTitle(" ")).toBe("Untitled (fork)");
  });
});
