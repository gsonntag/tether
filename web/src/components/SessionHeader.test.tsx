(globalThis as any).location ??= { protocol: "http:", host: "localhost" };
(globalThis as any).document ??= { addEventListener() {}, visibilityState: "visible" };
(globalThis as any).window ??= { addEventListener() {} };
(globalThis as any).requestAnimationFrame ??= () => 0;

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LiveState, SessionSummary } from "../../../shared/transcript";

const { SessionHeader } = await import("./SessionHeader");

const session = { id: "claude:a", harness: "claude", nativeId: "a", projectPath: "/p", title: "T", mode: "live", status: "idle", updatedAt: 0 } as unknown as SessionSummary;
const state = { mode: "live", status: "idle", requests: [], queue: [], model: "haiku", fallbackChain: { enabled: true, active: 1, steps: [{ harness: "claude", source: "plan", model: "opus" }, { harness: "antigravity", source: "plan", model: "m" }] } } as unknown as LiveState;

function render(s: SessionSummary) {
  return renderToStaticMarkup(<SessionHeader runnerId="r" session={s} state={state} children={[]} />);
}

test("the fallback chain chip sits with the scrolling choices, not beside the source chip", () => {
  const html = render(session);
  const options = html.indexOf('class="t-chip-options"');
  const chip = html.indexOf("t-fallback-chip");
  expect(options).toBeGreaterThan(-1);
  expect(chip).toBeGreaterThan(options);
  expect(html).toContain("Fallback chain · 2/2 · Antigravity");
});

test("subagents and side chats have no fallback chain chip", () => {
  expect(render({ ...session, parentSessionId: "claude:p" })).not.toContain("t-fallback-chip");
  expect(render({ ...session, sideOf: "claude:p" })).not.toContain("t-fallback-chip");
});
