import { expect, test } from "bun:test";
import type { SourceChoices } from "../../shared/credentials";
import { isApiBilling } from "../../shared/labels";
import type { LiveState } from "../../shared/transcript";
import { billingForDisplay, CURRENT_SOURCE, sourceMenu, switchBlocked, visibleNextBilling } from "./sourceMenu";

const state = (o: Partial<LiveState> = {}): LiveState => ({ mode: "live", status: "idle", requests: [], queue: [], ...o });
const plan = { kind: "plan", label: "Claude plan" } as const;
const key = { kind: "apiKey", label: "Anthropic API key" } as const;
const both: SourceChoices = { options: [{ source: "subscription", billing: plan }, { source: "anthropic", billing: key }] };

test("the harness's sources, its own marked, and no way to add a key that's set", () => {
  const m = sourceMenu("claude", state({ billing: plan }), both);
  expect(m.items.map((i) => i.label)).toEqual(["Claude plan", "Anthropic API key"]);
  expect(m.value).toBe("subscription");
  expect(m.addKey).toBe(false);
});

test("what's next is what's marked; the confirmed one is the way back", () => {
  expect(sourceMenu("claude", state({ billing: plan, nextBilling: key }), both).value).toBe("anthropic");
});

test("a completed turn shows its queued source, while a running turn keeps its confirmed source", () => {
  const completed = state({ billing: key, nextBilling: plan });
  expect(billingForDisplay(completed)).toBe(plan);
  expect(isApiBilling(billingForDisplay(completed))).toBe(false);
  expect(visibleNextBilling(completed)).toBeUndefined();
  expect(sourceMenu("claude", completed, both).value).toBe("subscription");

  for (const status of ["running", "waiting"] as const) {
    const running = state({ status, billing: key, nextBilling: plan });
    expect(billingForDisplay(running)).toBe(key);
    expect(isApiBilling(billingForDisplay(running))).toBe(true);
    expect(visibleNextBilling(running)).toBe(plan);
    expect(sourceMenu("claude", running, both).value).toBe("anthropic");
  }

  const terminal = state({ mode: "terminal", billing: key, nextBilling: plan, terminal: { kind: "shared" } });
  expect(billingForDisplay(terminal)).toBe(key);
  expect(visibleNextBilling(terminal)).toBe(plan);
});

test("a key that isn't set: Add API key, on any harness with one missing", () => {
  const only: SourceChoices = { options: [{ source: "subscription", billing: plan }] };
  expect(sourceMenu("claude", state({ billing: plan }), only).addKey).toBe(true);
  const chatgpt = { kind: "plan", label: "ChatGPT plan" } as const;
  const openai = { kind: "apiKey", label: "OpenAI API key" } as const;
  expect(sourceMenu("codex", state({ billing: chatgpt }), { options: [{ source: "subscription", billing: chatgpt }, { source: "openai", billing: openai }] }).addKey).toBe(true);
  expect(sourceMenu("codex", state({ billing: chatgpt }), { options: [{ source: "subscription", billing: chatgpt }, { source: "openai", billing: openai }, { source: "azure", billing: { kind: "provider", label: "Azure" } }] }).addKey).toBe(false);
});

test("a session on a key that was unset still shows where it is; Unknown marks nothing", () => {
  const m = sourceMenu("claude", state({ billing: key }), { options: [{ source: "subscription", billing: plan }] });
  expect(m.items[0]).toEqual({ value: CURRENT_SOURCE, label: "Anthropic API key" });
  expect(m.value).toBe(CURRENT_SOURCE);
  const u = sourceMenu("claude", state({ billing: { kind: "unknown", label: "Unknown" } }), both);
  expect(u.value).toBeUndefined();
  expect(u.items).toHaveLength(2);
  expect(sourceMenu("claude", state(), both).value).toBeUndefined();
});

test("refused with a reason on the others, whatever the harness", () => {
  for (const [s, why] of [[state({ billing: plan, status: "running" }), "Wait for the turn to end."], [state({ billing: plan, mode: "terminal" }), "Close the terminal first."], [state({ billing: plan, terminal: { kind: "shared" } }), "Close the terminal first."]] as const) {
    expect(switchBlocked(s)).toBe(why);
    const m = sourceMenu("claude", s, both);
    expect(m.items[0]!.reason).toBeUndefined();
    expect(m.items[1]!.reason).toBe(why);
  }
});
