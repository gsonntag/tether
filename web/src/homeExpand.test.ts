import { expect, test } from "bun:test";
import { escapeCollapses, loadExpanded, saveExpanded } from "./homeExpand";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

test("the expanded choice is kept, and collapsed is the default", () => {
  const s = memory();
  expect(loadExpanded(s)).toBe(false);
  saveExpanded(true, s);
  expect(loadExpanded(s)).toBe(true);
  saveExpanded(false, s);
  expect(loadExpanded(s)).toBe(false);
  // Storage that throws (private mode): collapsed, and saving doesn't throw.
  const broken = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); }, removeItem: () => { throw new Error("no"); } };
  expect(loadExpanded(broken)).toBe(false);
  expect(() => saveExpanded(true, broken)).not.toThrow();
});

test("Escape collapses unless something else took it or a popover is open", () => {
  expect(escapeCollapses({ key: "Escape", defaultPrevented: false }, false)).toBe(true);
  expect(escapeCollapses({ key: "Enter", defaultPrevented: false }, false)).toBe(false);
  expect(escapeCollapses({ key: "Escape", defaultPrevented: true }, false)).toBe(false);
  expect(escapeCollapses({ key: "Escape", defaultPrevented: false, isComposing: true }, false)).toBe(false);
  expect(escapeCollapses({ key: "Escape", defaultPrevented: false }, true)).toBe(false);
});
