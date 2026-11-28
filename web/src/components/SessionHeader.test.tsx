(globalThis as any).location ??= { protocol: "http:", host: "localhost" };
(globalThis as any).document ??= { addEventListener() {}, visibilityState: "visible" };
(globalThis as any).window ??= { addEventListener() {} };
(globalThis as any).requestAnimationFrame ??= () => 0;

import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountSource } from "../../../shared/credentials";
import type { LiveState, SessionSummary } from "../../../shared/transcript";

const { clearAccountLabelCache, seedAccountLabelCache } = await import("../accountLabel");
const { useStore } = await import("../store");
const { SessionHeader } = await import("./SessionHeader");

afterEach(() => {
  clearAccountLabelCache();
  useStore.setState({ link: "connecting", runners: [] });
});

const session = { id: "claude:a", harness: "claude", nativeId: "a", projectPath: "/p", title: "T", mode: "live", status: "idle", updatedAt: 0 } as unknown as SessionSummary;
const state = { mode: "live", status: "idle", requests: [], queue: [], model: "haiku", fallbackChain: { enabled: true, active: 1, steps: [{ harness: "claude", source: "plan", model: "opus" }, { harness: "antigravity", source: "plan", model: "m" }] } } as unknown as LiveState;

function render(s: SessionSummary, st: LiveState = state) {
  return renderToStaticMarkup(<SessionHeader runnerId="r" session={s} state={st} children={[]} />);
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

test("an owner's Next: chip shows the account name instead of the hex label (G8)", () => {
  const acc: AccountSource = "account:3f2a9c1e-1111-4222-8333-444444444444";
  useStore.setState({
    link: "open",
    runners: [{ id: "r", name: "R", online: true, access: "manage", harnesses: ["claude"], projects: [] } as any],
  });
  seedAccountLabelCache("r", "claude", {
    labels: { [acc]: "Work · Max" },
    entries: { [acc]: { name: "Work", detail: "Max", label: "Work · Max" } },
    probes: { [acc]: "signedIn" },
  });
  const nextState: LiveState = {
    mode: "live",
    status: "running",
    requests: [],
    queue: [],
    model: "sonnet",
    billing: { kind: "plan", label: "Claude plan" },
    nextBilling: { kind: "plan", label: "Claude plan · 3f2a9c1e", source: acc },
  };
  const ownerHtml = render(session, nextState);
  expect(ownerHtml).toContain("Next: Work · Max");
  expect(ownerHtml).not.toContain("3f2a9c1e");

  // Idle session with nextBilling renders owner account label on BillingChip too.
  const idleHtml = render(session, { ...nextState, status: "idle" });
  expect(idleHtml).toContain("Work · Max");
  expect(idleHtml).not.toContain("3f2a9c1e");

  // Drive user keeps the opaque runner label.
  useStore.setState({
    runners: [{ id: "r", name: "R", online: true, access: "drive", harnesses: ["claude"], projects: [] } as any],
  });
  const driveHtml = render(session, nextState);
  expect(driveHtml).toContain("Next: Claude plan · 3f2a9c1e");
  expect(driveHtml).not.toContain("Work · Max");
});
