import { expect, test } from "bun:test";
import { lineDiff, withContext } from "./diff";

test("a line diff keeps common lines and marks the change", () => {
  const d = lineDiff("a\nb\nc\nd", "a\nB\nc\nd\ne");
  expect(d.map((l) => l.op + l.text)).toEqual([" a", "-b", "+B", " c", " d", "+e"]);
  expect(lineDiff("", "x").map((l) => l.op + l.text)).toEqual(["+x"]);
});

test("context trims long unchanged runs into gaps", () => {
  const old = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
  const neu = old.replace("l10", "L10");
  const c = withContext(lineDiff(old, neu), 2);
  expect(c[0]).toEqual({ op: "gap", count: 8 });
  expect(c.filter((l) => l.op !== "gap").map((l: any) => l.op + l.text)).toEqual([" l8", " l9", "-l10", "+L10", " l11", " l12"]);
  expect(c.at(-1)).toEqual({ op: "gap", count: 7 });
});
