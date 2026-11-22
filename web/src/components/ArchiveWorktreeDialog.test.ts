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
  // nothing to clean up
  expect(cleanupText({})).toBeUndefined();
  expect(cleanupText({ removed: false, why: "it has uncommitted changes" })).toBe("Archived, but its worktree stays: it has uncommitted changes.");
  expect(cleanupText({ slow: true })).toContain("still checking");
});

test("the question is one wrapping paragraph and the buttons can wrap (not a flex row of text runs that clips on a phone)", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { readFileSync } = await import("node:fs");
  const { ArchiveWorktreeQuestion } = await import("./ArchiveWorktreeDialog");
  const session = { id: "claude:s", title: "Fix it", projectPath: "/home/u/wt/feature-x", worktreeBranch: "tether/feature-x" } as any;
  const html = renderToStaticMarkup(createElement(ArchiveWorktreeQuestion, { session }));
  expect(html.startsWith('<p class="t-dialog-text">')).toBe(true);
  expect(html).toContain("<code>feature-x</code> on <code>tether/feature-x</code>");
  const src = readFileSync(new URL("./ArchiveWorktreeDialog.tsx", import.meta.url), "utf8");
  expect(src).not.toContain("t-inline-status");
  expect(src.match(/className="t-dialog-actions"/g)?.length).toBe(2);
  const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
  const rule = (sel: string) => css.match(new RegExp(`\\n${sel.replace(".", "\\.")} \\{([^}]*)\\}`))?.[1] ?? "";
  expect(rule(".t-dialog-text")).toContain("overflow-wrap: anywhere");
  expect(rule(".t-dialog-text")).not.toContain("display: flex");
  expect(rule(".t-dialog-actions")).toContain("flex-wrap: wrap");
});
