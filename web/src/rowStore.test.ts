import { expect, test } from "bun:test";
import type { Part } from "../../shared/transcript";
import { partRev, RowStore } from "./rowStore";

test("a row's state outlives the row, and goes with its session", () => {
  const s = new RowStore();
  expect(s.get<boolean | undefined>("a", "tool:1", undefined)).toBeUndefined();
  s.set("a", "tool:1", true);
  s.set("b", "tool:1", false);
  // the row was unmounted and mounted again: it reads what it left
  expect(s.get("a", "tool:1", false)).toBe(true);
  expect(s.get("a", "tool:2", "x")).toBe("x");
  // the session's view closed
  s.drop("a");
  expect(s.get("a", "tool:1", false)).toBe(false);
  expect(s.get("b", "tool:1", true)).toBe(false);
  expect(s.size).toBe(1);
});

test("a part's revision changes with its content", () => {
  const text: Part = { type: "text", text: "abc", truncated: 10 };
  expect(partRev(text)).toBe(partRev({ ...text }));
  expect(partRev(text)).not.toBe(partRev({ ...text, truncated: 20 }));
  const tool = { type: "tool", id: "t", name: "Bash", kind: "shell", input: {}, status: "running", output: "a" } as Part;
  expect(partRev(tool)).not.toBe(partRev({ ...tool, status: "done" } as Part));
  expect(partRev(tool)).not.toBe(partRev({ ...tool, output: "ab" } as Part));
  expect(partRev(undefined)).toBe("");
});
