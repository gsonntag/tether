import { expect, test } from "bun:test";
import { arrowPick } from "./radioKeys";

test("arrow keys move the pick, wrapping; other keys don't", () => {
  const v = ["folder", "worktree"] as const;
  expect(arrowPick(v, "folder", "ArrowRight")).toBe("worktree");
  expect(arrowPick(v, "worktree", "ArrowDown")).toBe("folder");
  expect(arrowPick(v, "folder", "ArrowLeft")).toBe("worktree");
  expect(arrowPick(v, "worktree", "ArrowUp")).toBe("folder");
  expect(arrowPick(v, "folder", "Enter")).toBeUndefined();
});
