import { expect, test } from "bun:test";

// The dialog reaches the app's connection module, which reads the page's address when loaded.
(globalThis as any).location ??= { protocol: "http:", host: "localhost" };
(globalThis as any).document ??= { addEventListener() {}, visibilityState: "visible" };
(globalThis as any).window ??= { addEventListener() {} };
(globalThis as any).requestAnimationFrame ??= () => 0;
const { cleanupText } = await import("./ArchiveWorktreeDialog");

test("after Delete: nothing to say once it's gone, else why it stays (or that it's still being checked)", () => {
  expect(cleanupText({ removed: true })).toBeUndefined();
  expect(cleanupText(undefined)).toBeUndefined();
  expect(cleanupText({ removed: false, why: "it has uncommitted changes" })).toBe("Archived, but its worktree stays: it has uncommitted changes.");
  expect(cleanupText({ slow: true })).toContain("still checking");
});
