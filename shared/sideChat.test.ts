import { expect, test } from "bun:test";
import { bringBackDraft, BRING_BACK_PROMPT, parseBtw, sideChatTitle } from "./sideChat";
import { tetherOrigin } from "./fromTether";

test("/btw and its question", () => {
  expect(parseBtw("/btw what does x do?")).toBe("what does x do?");
  expect(parseBtw("  /Btw   q  ")).toBe("q");
  expect(parseBtw("/btw")).toBe("");
  expect(parseBtw("/btwq")).toBeUndefined();
  expect(parseBtw("btw q")).toBeUndefined();
});

test("a side chat's title is its question, short; else its session's", () => {
  expect(sideChatTitle("why\n7?", "Numbers")).toBe("Side chat: why 7?");
  expect(sideChatTitle("", " Numbers ")).toBe("Side chat: Numbers");
  expect(sideChatTitle("x".repeat(100), "N")).toBe(`Side chat: ${"x".repeat(59)}…`);
});

test("Bring back's turn is Tether's; its draft says where it's from", () => {
  expect(tetherOrigin(BRING_BACK_PROMPT)?.origin.kind).toBe("tether");
  expect(bringBackDraft("  done.\n")).toBe("From a side chat:\n\ndone.");
});
