import { expect, test } from "bun:test";
import { collapseErrors, repeatsError } from "./notices";
import type { Msg } from "./transcript";

const say = (text: string, level: Msg["level"] = "error", id = text): Msg => ({ id, role: "notice", level, ts: 0, parts: [{ type: "text", text }] });
const e = (id: string, text = "Boom.") => say(text, "error", id);
const you = (id: string, more: Partial<Msg> = {}): Msg => ({ id, role: "user", ts: 0, parts: [{ type: "text", text: id }], ...more });
const reply = (id: string): Msg => ({ id, role: "assistant", ts: 0, parts: [{ type: "text", text: id }] });
const shown = (list: Msg[]) => collapseErrors(list).messages.map((m) => m.id);

test("the same error in a row is one row, the first", () => {
  expect(shown([reply("a"), e("1"), e("2"), e("3"), e("4"), e("5")])).toEqual(["a", "1"]);
  expect(collapseErrors([e("1"), e("2"), e("3")]).hidden).toEqual(new Map([["2", "1"], ["3", "1"]]));
});

test("with and without the start prefix is the same error", () => {
  expect(shown([e("1", "Couldn't start Codex: Boom."), e("2", "Boom."), e("3", "Couldn't start Claude Code: Boom.")])).toEqual(["1"]);
  expect(repeatsError(e("1", "Couldn't start Codex: Boom."), e("2", "Boom."))).toBe(true);
});

test("a kept notice, cut at 2000 characters, is the same error as the whole one", () => {
  const long = "x".repeat(3000);
  expect(shown([e("1", `${long.slice(0, 2000)}…`), e("2", long)])).toEqual(["1"]);
});

test("a message you sent between two failures failed too, and says so", () => {
  const r = collapseErrors([you("u1"), e("1"), you("u2"), e("2"), you("u3"), you("u4"), e("3")]);
  expect(r.messages.map((m) => m.id)).toEqual(["u1", "1", "u2", "u3", "u4"]);
  expect([...r.failed]).toEqual(["u2", "u3", "u4"]);
});

test("a message still waiting for its answer hasn't failed", () => {
  const r = collapseErrors([e("1"), you("u")]);
  expect(r.messages.map((m) => m.id)).toEqual(["1", "u"]);
  expect(r.failed.size).toBe(0);
});

test("anything else between them ends the run", () => {
  expect(shown([e("1"), reply("a"), e("2")])).toEqual(["1", "a", "2"]);
  expect(shown([e("1"), you("u"), reply("a"), e("2")])).toEqual(["1", "u", "a", "2"]);
  expect(shown([e("1"), say("Interrupted", "info"), e("2")])).toEqual(["1", "Interrupted", "2"]);
  expect(shown([e("1"), you("c", { shell: {} as any }), e("2")])).toEqual(["1", "c", "2"]);
  expect(shown([e("1"), e("2", "Another."), e("3")])).toEqual(["1", "2", "3"]);
});

test("an agent's reply that never said anything doesn't end it", () => {
  expect(shown([e("1"), you("u"), { id: "a", role: "assistant", ts: 0, parts: [] }, e("2")])).toEqual(["1", "u", "a"]);
});

test("only errors collapse", () => {
  expect(shown([say("Note", "warning", "1"), say("Note", "warning", "2"), say("Hi", "info", "3"), say("Hi", "info", "4")])).toEqual(["1", "2", "3", "4"]);
});

test("nothing to collapse: the same list, so a long session pays for no copy", () => {
  const list = [you("u"), e("1"), reply("a")];
  expect(collapseErrors(list).messages).toBe(list);
});
