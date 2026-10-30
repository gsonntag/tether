import { expect, test } from "bun:test";
import { folderBlocked } from "./folderCheck";

const at = (state: "exists" | "missing" | "relative" | "error") => ({ path: "/x", state });

test("a missing folder waits for the confirmation; a bad one never starts", () => {
  expect(folderBlocked(at("exists"), false)).toBe(false);
  expect(folderBlocked(at("missing"), false)).toBe(true);
  expect(folderBlocked(at("missing"), true)).toBe(false);
  expect(folderBlocked(at("relative"), true)).toBe(true);
  expect(folderBlocked(at("error"), true)).toBe(true);
});

test("no answer leaves it to the runner", () => {
  expect(folderBlocked(undefined, false)).toBe(false);
});
