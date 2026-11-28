import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Row } from "../sessionList";

// The row reaches the app's connection module, which reads the page's address when loaded.
(globalThis as any).location ??= { protocol: "http:", host: "localhost" };
(globalThis as any).document ??= { addEventListener() {}, visibilityState: "visible" };
(globalThis as any).window ??= { addEventListener() {} };
(globalThis as any).requestAnimationFrame ??= () => 0;
const { HarnessGlyph, SessionRow } = await import("./SessionRow");

const row = (extra: Partial<Row> = {}): Row => ({ id: "claude:a", runnerId: "r1", harness: "claude", nativeId: "a", projectPath: "/p/web", title: "Fix login", mode: "stored", status: "idle", updatedAt: 1, ...extra });
const render = (r: Row, canPin = true) => renderToStaticMarkup(<SessionRow row={r} now={2} selected={false} canPin={canPin} />);

test("the pin button: one stable label, pressed when pinned, room kept only on a pinned row", () => {
  const off = render(row());
  expect(off).toContain('aria-label="Pin session: Fix login"');
  expect(off).toContain('aria-pressed="false"');
  expect(off).toContain("t-pinnable");
  expect(off).not.toContain("t-pinned");
  const on = render(row({ pinned: 5 }));
  expect(on).toContain('aria-label="Pin session: Fix login"');
  expect(on).toContain('aria-pressed="true"');
  expect(on).toContain("t-pinned");
});

test("no pin button on a runner from before pinSession or a subagent; an archived row has one (pinning unarchives)", () => {
  expect(render(row(), false)).not.toContain("t-row-pin");
  expect(render(row({ archived: true }))).toContain("t-row-pin");
  expect(renderToStaticMarkup(<SessionRow row={row({ parentSessionId: "claude:b" })} now={2} selected={false} child canPin />)).not.toContain("t-row-pin");
});

test("a pinned session its runner can't find: dimmed, marked, no archive, still unpinnable", () => {
  const html = render(row({ pinned: 5, missing: true }));
  expect(html).toContain("t-missing");
  expect(html).toContain("Not found on this computer");
  expect(html).not.toContain("Archive session");
  // nothing to open
  expect(html).toMatch(/class="t-row-open"[^>]*disabled=""/);
  expect(html).toContain('aria-pressed="true"');
});

test("under a project's subheader the row leaves the project out", () => {
  expect(render(row())).toContain('<span class="t-proj">web</span>');
  const grouped = renderToStaticMarkup(<SessionRow row={row()} now={2} selected={false} canPin hideProject runnerLabel="box" />);
  expect(grouped).not.toContain('<span class="t-proj">web</span>');
  expect(grouped).toContain('<span class="t-proj">box</span>');
});

test("a worktree session shows its branch: beside its main checkout's name, or alone under the group", () => {
  const wt = row({ projectPath: "/p/web-worktrees/tether-fix", worktreeOf: "/p/web", worktreeBranch: "tether/fix" });
  const flat = render(wt);
  expect(flat).toContain('<span class="t-proj">web</span>');
  expect(flat).toContain("tether/fix");
  const grouped = renderToStaticMarkup(<SessionRow row={wt} now={2} selected={false} hideProject />);
  expect(grouped).not.toContain('<span class="t-proj">web</span>');
  expect(grouped).toContain("tether/fix");
});

test("session rows in the sidebar have plain title text with no payment-source marker or differentiator", () => {
  const apiRow = render(row({ billing: { kind: "apiKey", label: "Anthropic API key" } }));
  expect(apiRow).not.toContain("t-api-title");
  expect(apiRow).not.toContain("Anthropic API key");
  expect(apiRow).toContain('aria-label="Open session: Fix login"');
  expect(apiRow).toContain('<span class="t-row-title t-row-title-editor">');
  expect(apiRow).toContain('title="Fix login"');
});

test("HarnessGlyph renders SVG logos for Claude, Codex, and Antigravity instead of temp symbols", () => {
  const claude = renderToStaticMarkup(<HarnessGlyph harness="claude" />);
  const codex = renderToStaticMarkup(<HarnessGlyph harness="codex" />);
  const agy = renderToStaticMarkup(<HarnessGlyph harness="antigravity" />);
  expect(claude).toContain('aria-label="Claude Code"');
  expect(claude).toContain("<svg");
  expect(claude).toContain("#D97757");
  expect(claude).not.toContain("✻");
  expect(codex).toContain('aria-label="Codex"');
  expect(codex).toContain("<svg");
  expect(codex).toContain('fill="currentColor"');
  expect(codex).not.toContain("◎");
  expect(agy).toContain('aria-label="Antigravity"');
  expect(agy).toContain("<svg");
  expect(agy).toContain("<linearGradient");
  expect(agy).not.toContain("▲");
});
