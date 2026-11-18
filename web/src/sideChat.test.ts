import { expect, test } from "bun:test";
import type { HarnessCapabilities, SessionSummary } from "../../shared/transcript";
import { btwQuestion, canSideChat, withBtw } from "./sideChat";
import { awaitedSessions, inbox, recentSessions, setHomeFolders, sideChatsOf, waitingOn } from "./sessionList";
import { canFork } from "./fork";

const caps = (over: Partial<HarnessCapabilities> = {}): HarnessCapabilities => ({ canSteer: true, terminal: "handoff", subagents: { view: true, stop: true, steer: false }, fork: true, readOnlyMode: "plan", ...over });

test("side chats are offered on a main session that forks, on a harness with a read-only mode", () => {
  expect(canSideChat("r", { projectPath: "/p" }, caps(), {})).toBe(true);
  expect(canSideChat("r", { projectPath: "/p", sideOf: "claude:a" }, caps(), {})).toBe(false);
  expect(canSideChat("r", { projectPath: "/p", parentSessionId: "claude:a" }, caps(), {})).toBe(false);
  expect(canSideChat("r", { projectPath: "/p" }, caps({ readOnlyMode: undefined }), {})).toBe(false);
  expect(canSideChat("r", { projectPath: "/p" }, caps({ fork: undefined }), {})).toBe(false);
  expect(canSideChat("r", { projectPath: "/p" }, caps(), { nextBilling: { kind: "plan", label: "Claude plan" } })).toBe(false);
  // Not on the Home agent's chats.
  setHomeFolders([{ id: "r", homeFolder: "/home-agent" }]);
  expect(canSideChat("r", { projectPath: "/home-agent" }, caps(), {})).toBe(false);
  expect(canSideChat("other", { projectPath: "/home-agent" }, caps(), {})).toBe(true);
  setHomeFolders([]);
  // A side chat isn't forked either.
  expect(canFork({ sideOf: "claude:a" }, caps(), {})).toBe(false);
});

test("/btw is Tether's: first in the menu, and the box's question when side chats are offered", () => {
  expect(withBtw([{ name: "compact", description: "" }]).map((c) => c.name)).toEqual(["btw", "compact"]);
  // A harness command of the same name is Tether's here.
  expect(withBtw([{ name: "btw", description: "theirs" }]).map((c) => c.description)).not.toContain("theirs");
  expect(btwQuestion("/btw why is the sky blue?", true)).toBe("why is the sky blue?");
  expect(btwQuestion("/BTW  two\nlines ", true)).toBe("two\nlines");
  expect(btwQuestion("/btw", true)).toBe("");
  expect(btwQuestion("/btwx", true)).toBeUndefined();
  expect(btwQuestion("by the way /btw", true)).toBeUndefined();
  // Not offered: it goes to the harness as typed.
  expect(btwQuestion("/btw hi", false)).toBeUndefined();
});

test("side chats stay out of every list, and show under their session", () => {
  const s = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({ id, harness: "claude", nativeId: id, projectPath: "/p", title: id, mode: "live", status: "running", updatedAt: 1, ...over });
  const summaries = { r: { epoch: "e", seq: 1, sessions: { a: s("a"), b: s("b", { sideOf: "a", requests: 1, unread: "finished" }) } } } as any;
  expect(recentSessions(summaries).map((r) => r.id)).toEqual(["a"]);
  expect(recentSessions(summaries, "b").map((r) => r.id)).toEqual([]);
  expect(waitingOn(summaries, "r")).toEqual([]);
  expect(inbox(summaries).map((r) => r.id)).toEqual(["a"]);
  expect(awaitedSessions(summaries, "r", { watchAll: true }).rows.map((r) => r.id)).toEqual(["a"]);
  expect(sideChatsOf(summaries, "r", "a").map((r) => r.id)).toEqual(["b"]);
  expect(sideChatsOf(summaries, "x", "a")).toEqual([]);
});

test("the panel opens at once, read only, while the fork is made", async () => {
  (globalThis as any).location ??= { protocol: "http:", host: "localhost" };
  (globalThis as any).document ??= { addEventListener() {}, visibilityState: "visible" };
  (globalThis as any).window ??= { addEventListener() {} };
  (globalThis as any).requestAnimationFrame ??= () => 0;
  (globalThis as any).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { SideChatPanel, SideChatChips } = await import("./components/SideChatPanel");
  const html = renderToStaticMarkup(createElement(SideChatPanel, { runnerId: "r", side: { opening: true, question: "q" }, onBringBack: () => {}, onClose: () => {} }));
  expect(html).toContain("Read only");
  expect(html).toContain("Opening a read-only fork to ask it");
  expect(html).toContain('aria-label="Close side chat"');
  expect(html).not.toContain('role="dialog"');
  // Over the session (a phone): a modal dialog.
  const sheet = renderToStaticMarkup(createElement(SideChatPanel, { runnerId: "r", side: { opening: true, question: "" }, sheet: true, onBringBack: () => {}, onClose: () => {} }));
  expect(sheet).toContain('role="dialog"');
  expect(sheet).toContain('aria-modal="true"');
  const row = (id: string, archived?: boolean) => ({ id, harness: "claude", nativeId: id, projectPath: "/p", title: id, mode: "stored", status: "idle", updatedAt: 1, runnerId: "r", sideOf: "a", ...(archived ? { archived } : {}) }) as any;
  expect(renderToStaticMarkup(createElement(SideChatChips, { chats: [row("b"), row("c", true)], onOpen: () => {} }))).toContain("Side chats");
  expect(renderToStaticMarkup(createElement(SideChatChips, { chats: [], onOpen: () => {} }))).toBe("");
});
