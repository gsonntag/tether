import { expect, test } from "bun:test";
import type { Msg } from "../../../shared/transcript";
import { DIFF_RESET_OVER, diffTranscripts } from "./transcript";

const a = (id: string, text = id, extra: Partial<Msg> = {}): Msg => ({ id, role: "assistant", ts: 1, parts: [{ type: "thinking", text: "live thought" }, { type: "text", text }], ...extra });

test("the store's copy of a live transcript is no change: time, streaming, thinking and key order aside", () => {
  const live = [a("m1"), a("m2", "m2", { streaming: false, model: "x" })];
  const stored: Msg[] = [
    { ...a("m1"), ts: 99, parts: [{ type: "thinking", text: "" }, { type: "text", text: "m1" }] },
    { parts: [{ text: "", type: "thinking" }, { text: "m2", type: "text" }], model: "x", ts: 5, role: "assistant", id: "m2" },
  ];
  expect(diffTranscripts(live, stored)).toEqual([]);
  expect(diffTranscripts(live, [...stored, a("m3")])).toEqual([{ type: "msg", msg: a("m3") }]);
  expect(diffTranscripts(live, [stored[0]!, a("m2", "edited")])).toEqual([{ type: "msg", msg: a("m2", "edited") }]);
});

test("a big change or a rewrite is one reset", () => {
  const from = Array.from({ length: 80 }, (_, i) => a(`m${i}`));
  const to = from.map((m) => a(m.id, `${m.id}!`));
  const out = diffTranscripts(from, to);
  expect(to.length).toBeGreaterThan(DIFF_RESET_OVER);
  expect(out).toEqual([{ type: "reset", messages: to, hasOlder: false }]);
  expect(diffTranscripts([a("x"), a("y")], [a("y")])[0]!.type).toBe("reset");
});
