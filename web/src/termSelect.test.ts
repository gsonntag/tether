import { expect, test } from "bun:test";
import { copyable, forceSelection, isDrag, isPlainPress } from "./termSelect";

const press = { button: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };

test("an empty or blank selection copies nothing; text copies exactly as selected", () => {
  expect(copyable("")).toBeUndefined();
  expect(copyable(" \n\n ")).toBeUndefined();
  expect(copyable("  a b\n")).toBe("  a b\n");
});

test("only a plain left press waits to see whether it is a drag", () => {
  expect(isPlainPress(press)).toBe(true);
  expect(isPlainPress({ ...press, button: 2 })).toBe(false);
  for (const k of ["shiftKey", "altKey", "ctrlKey", "metaKey"]) expect(isPlainPress({ ...press, [k]: true })).toBe(false);
});

test("a wobble is still a click; a few pixels is a drag", () => {
  const a = { clientX: 10, clientY: 10 };
  expect(isDrag(a, { clientX: 12, clientY: 11 })).toBe(false);
  expect(isDrag(a, { clientX: 14, clientY: 10 })).toBe(true);
  expect(isDrag(a, { clientX: 10, clientY: 6 })).toBe(true);
});

test("the modifier that forces a selection: Option on a Mac, Shift elsewhere (Alt would mean a column)", () => {
  expect(forceSelection("MacIntel")).toEqual({ altKey: true });
  expect(forceSelection("Linux x86_64")).toEqual({ shiftKey: true });
  expect(forceSelection("Win32")).toEqual({ shiftKey: true });
});
