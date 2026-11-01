import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Mounting the composer takes a browser (scripts/ cover that); this keeps its source honest.
const source = (name: string) => readFileSync(join(import.meta.dir, name), "utf8");

test("nothing red above the composer: failures go to the chat", () => {
  const composer = source("Composer.tsx");
  expect(composer).not.toContain("t-inline-status error");
  expect(composer).not.toContain("status?:");
  expect(source("SessionView.tsx")).not.toContain("state.error");
  // Every failed send and Stop hands its message on; only hints about the box stay here.
  expect(composer.match(/catch \(e\) \{\n\s+onFailed\(\(e as Error\)\.message\);/g)?.length).toBe(3);
  expect(composer.match(/setHint\(["`]/g)?.length).toBe(3);
});
