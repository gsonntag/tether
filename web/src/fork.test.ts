import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { canFork, forkedFromTitle, forkRunning } from "./fork";
import { forkPoints } from "../../shared/fork";
import type { HarnessCapabilities, Msg } from "../../shared/transcript";

(globalThis as any).location ??= { protocol: "http:", host: "localhost" };
(globalThis as any).document ??= { addEventListener() {}, visibilityState: "visible" };
(globalThis as any).window ??= { addEventListener() {} };
(globalThis as any).requestAnimationFrame ??= () => 0;
const { Message } = await import("./components/Message");
const { SessionCtx } = await import("./components/sessionContext");

const caps = (fork?: boolean): HarnessCapabilities => ({ canSteer: true, terminal: "handoff", subagents: { view: true, stop: true, steer: false }, ...(fork ? { fork } : {}) });

test("the session menu has Fork on a main session whose harness forks, on a confirmed source", () => {
  expect(canFork({}, caps(true), {})).toBe(true);
  expect(canFork({ parentSessionId: "claude:x" }, caps(true), {})).toBe(false);
  expect(canFork({}, caps(), {})).toBe(false);
  expect(canFork({}, undefined, {})).toBe(false);
  expect(canFork({}, caps(true), { nextBilling: { kind: "apiKey", label: "Anthropic API key" } })).toBe(false);
});

const reply = (id: string, text: string): Msg => ({ id, role: "assistant", ts: 2, parts: [{ type: "text", text }] });
const render = (msg: Msg, forkable: boolean, fork = true) =>
  renderToStaticMarkup(createElement(SessionCtx.Provider, { value: { runnerId: "r", sessionId: "claude:s", ...(fork ? { fork: { running: false, from: () => {} } } : {}) } }, createElement(Message, { msg, forkable })));

test("Fork from here shows under a reply that ends a turn, and nowhere else", () => {
  const msgs: Msg[] = [{ id: "u1", role: "user", ts: 1, parts: [{ type: "text", text: "hi" }] }, reply("a1", "Hello."), { id: "u2", role: "user", ts: 3, parts: [{ type: "text", text: "more" }] }, reply("a2", "Sure.")];
  const points = forkPoints(msgs, true);
  expect(render(msgs[1]!, points.has("a1"))).toContain("Fork from here");
  // The running turn's reply isn't finished.
  expect(render(msgs[3]!, points.has("a2"))).not.toContain("Fork from here");
  // A session that can't fork (a subagent) has no fork in its context.
  expect(render(msgs[1]!, true, false)).not.toContain("Fork from here");
});

test("a fork's header links back to where it came from, by that session's title now", async () => {
  const { ForkedFrom } = await import("./components/SessionHeader");
  const from = { sessionId: "claude:orig", title: "Old name" };
  expect(renderToStaticMarkup(createElement(ForkedFrom, { runnerId: "r", from }))).toContain("Forked from “Old name”");
  const listed = { r: { seq: 1, sessions: { "claude:orig": { id: "claude:orig", harness: "claude", nativeId: "orig", projectPath: "/p", title: "New name", mode: "stored", status: "idle", updatedAt: 1 } } } } as any;
  expect(forkedFromTitle(listed, "r", from)).toBe("New name");
  expect(forkedFromTitle({}, "r", from)).toBe("Old name");
  expect(forkedFromTitle({}, "r", { sessionId: "x" })).toBeUndefined();
});

test("a TUI that took the session over counts as running; a shared one doesn't", () => {
  expect(forkRunning({ status: "idle", mode: "stored" }, caps(true))).toBe(false);
  expect(forkRunning({ status: "running", mode: "live" }, caps(true))).toBe(true);
  expect(forkRunning({ status: "idle", mode: "terminal" }, caps(true))).toBe(true);
  expect(forkRunning({ status: "idle", mode: "live", terminal: { tmuxSession: "x" } as any }, { ...caps(true), terminal: "shared" })).toBe(false);
});

test("history brought in from elsewhere gets no Fork from here", () => {
  const msgs: Msg[] = [{ id: "m1", role: "user", ts: 1, noFork: true, parts: [{ type: "text", text: "moved" }] }, { ...reply("m2", "Ready."), noFork: true }];
  expect(forkPoints(msgs, false).size).toBe(0);
});

test("hidden on desktop, Fork from here takes no clicks but stays focusable", async () => {
  const css = await Bun.file(new URL("./app.css", import.meta.url)).text();
  const rule = css.slice(css.indexOf("@media (hover: hover) and (pointer: fine) {\n  /* Hidden, it takes no clicks"));
  expect(rule).toContain("pointer-events: none");
  expect(rule).not.toMatch(/\.t-fork-here\s*{[^}]*(display: none|visibility: hidden)/);
  expect(rule).toContain(".t-fork-here:focus-visible");
});
