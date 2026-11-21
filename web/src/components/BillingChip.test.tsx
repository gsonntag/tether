(globalThis as any).location ??= { protocol: "http:", host: "localhost" };
(globalThis as any).document ??= { addEventListener() {}, visibilityState: "visible" };
(globalThis as any).window ??= { addEventListener() {} };
(globalThis as any).requestAnimationFrame ??= () => 0;

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LiveState, SessionSummary } from "../../../shared/transcript";
import { SessionApiCostGroup } from "./SessionApiCostGroup";

const { BillingChip } = await import("./BillingChip");

test("the billing dropdown shows estimated partial API spend as a lower bound", () => {
  const html = renderToStaticMarkup(
    <SessionApiCostGroup billing={{ kind: "apiKey", label: "OpenAI API key" }} cost={{ usd: 0.02, estimated: true, complete: false, reasons: ["no-cache-ttl"] }} />,
  );

  expect(html).toContain("API key spend this session");
  expect(html).toContain("est. $0.02");
  expect(html).toContain("Known API subtotal $0.02 estimated");
  expect(html).toContain("not the session");
  expect(html).toContain("lower bound");
});

test("the billing dropdown labels missing API cost as unknown", () => {
  const html = renderToStaticMarkup(<SessionApiCostGroup billing={{ kind: "apiKey", label: "OpenAI API key" }} cost={undefined} />);
  expect(html).toContain("Cost unknown");
});

test("a subscription session with no API history has no API spend group", () => {
  const html = renderToStaticMarkup(<SessionApiCostGroup billing={{ kind: "plan", label: "ChatGPT plan" }} cost={undefined} />);
  expect(html).toBe("");
});

test("a subscription session with earlier untracked usage shows the API key spend group as Cost unknown", () => {
  const html = renderToStaticMarkup(<SessionApiCostGroup billing={{ kind: "plan", label: "Google AI plan" }} cost={{ estimated: true, complete: false, reasons: ["earlier-usage"] }} />);
  expect(html).toContain("API key spend this session");
  expect(html).toContain("Cost unknown");
});

test("a subscription session retains API spend from an earlier key period", () => {
  const html = renderToStaticMarkup(<SessionApiCostGroup billing={{ kind: "plan", label: "ChatGPT plan" }} cost={{ usd: 0.02, estimated: true, complete: true }} />);
  expect(html).toContain("API key spend this session");
  expect(html).toContain("est. $0.02");
});

const dummySession: SessionSummary = {
  id: "antigravity:1",
  harness: "antigravity",
  nativeId: "1",
  projectPath: "/home/ubuntu/repo",
  title: "Test",
  mode: "live",
  status: "idle",
  updatedAt: Date.now(),
};

test("a plan session without source switching is clickable when plan limits exist and shows limits directly", () => {
  const state: LiveState = {
    mode: "live",
    status: "idle",
    requests: [],
    queue: [],
    billing: { kind: "plan", label: "Google AI plan" },
    plan: {
      pools: [
        {
          id: "gemini",
          name: "Gemini",
          fiveHour: { percent: 8, resetsAt: Date.now() + 10_000_000 },
          week: { percent: 0, resetsAt: Date.now() + 500_000_000 },
        },
        {
          id: "other",
          name: "Other models",
          fiveHour: { percent: 100, resetsAt: Date.now() + 10_000_000 },
          week: { percent: 0, resetsAt: Date.now() + 500_000_000 },
        },
      ],
    },
  };

  const html = renderToStaticMarkup(<BillingChip runnerId="r1" session={dummySession} state={state} onSwitch={() => {}} />);
  // Clickable button trigger with down chevron
  expect(html).toContain("<button");
  expect(html).toContain("t-source-chip");
  // Displays limits directly without redundant plan name prefix
  expect(html).toContain("Gemini 5h 8% · Other 5h 100%");
  expect(html).not.toContain("Google AI plan · Gemini 5h 8%");
  // Accessible source label still identifies the plan
  expect(html).toContain('aria-label="Source: Google AI plan, Gemini 5h 8% · Other 5h 100%"');
});

test("a session without choices, plan lines, or cost renders a static span", () => {
  const state: LiveState = {
    mode: "live",
    status: "idle",
    requests: [],
    queue: [],
    billing: { kind: "plan", label: "Google AI plan" },
  };

  const html = renderToStaticMarkup(<BillingChip runnerId="r1" session={dummySession} state={state} onSwitch={() => {}} />);
  expect(html).toContain("<span");
  expect(html).not.toContain("<button");
  expect(html).toContain("Google AI plan");
});

test("a plan session without choices or plan lines renders a button when cost is present", () => {
  const state: LiveState = {
    mode: "live",
    status: "idle",
    requests: [],
    queue: [],
    billing: { kind: "plan", label: "Google AI plan" },
    cost: { estimated: true, complete: false, reasons: ["earlier-usage"] },
  };

  const html = renderToStaticMarkup(<BillingChip runnerId="r1" session={dummySession} state={state} onSwitch={() => {}} />);
  expect(html).toContain("<button");
  expect(html).toContain("t-source-chip");
});

test("a plan session without choices or plan lines stays a span when no cost is present", () => {
  const state: LiveState = {
    mode: "live",
    status: "idle",
    requests: [],
    queue: [],
    billing: { kind: "plan", label: "Google AI plan" },
  };

  const html = renderToStaticMarkup(<BillingChip runnerId="r1" session={dummySession} state={state} onSwitch={() => {}} />);
  expect(html).toContain("<span");
  expect(html).not.toContain("<button");
});
