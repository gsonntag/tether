import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveState } from "../../../../shared/transcript";
import { Transcript } from "../../core/transcript";
import { chainContext, claudeBilling, contextOf, contextUsed, forgetBilling, keepBilling, keptBilling, keptPlan, noteWindows, planOf, windowsIn } from "./context";
import { readStore } from "./jsonl";
import { ClaudeStream } from "./stream";

// Recorded from real Haiku runs (Claude Code 2.1.314): a reply, /context, a reply, /compact, a
// reply, /clear, a reply; and that session's store. Message text and tool lists are trimmed.
const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "fixtures", name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const FIRST = "6bb2c334-a4cf-4d47-aa8a-2b84be90bd6b";

const savedDir = process.env.CLAUDE_CONFIG_DIR;
beforeEach(() => {
  windowsIn(undefined);
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tether-catalog-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = savedDir;
  if (savedDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
});

function catalog(models: Record<string, number>) {
  const dir = join(process.env.CLAUDE_CONFIG_DIR!, "cache", "model-catalog");
  mkdirSync(dir, { recursive: true });
  const list = Object.entries(models).map(([id, max_input_tokens]) => ({ id, runtime: { max_input_tokens } }));
  writeFileSync(join(dir, "org-hash-cc.json"), JSON.stringify({ catalog: { config: { models: list } } }));
}

function replay(frames: any[], onFrame?: (m: any, state: Partial<LiveState>) => void, contextNow?: () => Promise<any>) {
  const t = new Transcript();
  const state: Partial<LiveState> = {};
  const sink: any = {
    event: (e: any) => t.apply(e),
    message: (id: string) => t.get(id),
    state: (p: any) => Object.assign(state, p),
    subagent: () => ({ ...sink, state() {}, event() {}, message: () => undefined }),
  };
  const s = new ClaudeStream(sink, { nativeId: FIRST, contextNow });
  for (const m of frames) {
    s.handle(m);
    onFrame?.(m, state);
  }
  return state;
}

test("the context is the last message's input, cache read and cache creation, not cumulative spend", () => {
  expect(contextUsed({ input_tokens: 2, cache_creation_input_tokens: 29555, cache_read_input_tokens: 0, output_tokens: 4 })).toBe(29557);
});

test("live: known from the result on, and from the message while it starts on a later turn", async () => {
  const frames = fixture("context.jsonl");
  const firstResult = frames.findIndex((m) => m.type === "result");
  const during: any[] = [];
  replay(frames.slice(0, firstResult + 1), (m, st) => during.push([m.type, st.context]));
  // Nothing says the window before the first result here (no catalog, nothing reported yet).
  expect(during.filter(([t]) => t === "assistant").every(([, c]) => c === undefined)).toBe(true);
  expect(during.at(-1)![1]).toEqual({ used: 29557, total: 1_000_000 });
  // Then the same model's next message reports during the turn, before its result.
  const second = frames.findIndex((m, i) => i > firstResult && m.type === "stream_event");
  let atStart: any;
  replay(frames.slice(0, second + 1), (_m, st) => (atStart = st.context));
  expect(atStart).toEqual({ used: 41190, total: 1_000_000 });
});

test("the catalog gives the window from the first message of a session nothing reported yet", () => {
  catalog({ "claude-haiku-5-5": 1_000_000 });
  const frames = fixture("context.jsonl");
  let at: any;
  replay(frames.slice(0, frames.findIndex((m) => m.type === "stream_event") + 1), (_m, st) => (at = st.context));
  expect(at).toEqual({ used: 29557, total: 1_000_000 });
});

test("a compaction and a /clear ask Claude Code for what's left, once the turn is over", async () => {
  const frames = fixture("context.jsonl");
  const counts = frames.filter((m) => m.type === "probe_context_usage");
  const asked: number[] = [];
  const seen: any[] = [];
  const state = replay(
    frames.filter((m) => m.type !== "probe_context_usage"),
    (m, st) => m.type === "result" && seen.push(st.context),
    async () => {
      asked.push(1);
      return { used: 23069, total: 1_000_000 };
    },
  );
  expect(asked.length).toBe(2);
  expect(counts.length).toBeGreaterThan(0);
  // Real: 41.2k before /compact, 33.3k on the message after it, 32.1k after /clear.
  expect(seen[2]).toEqual({ used: 41190, total: 1_000_000 });
  expect(state.context).toEqual({ used: 32086, total: 1_000_000 });
});

test("a compaction Claude Code can't count clears the chip rather than keeping the old number", async () => {
  const frames = fixture("context.jsonl");
  const cut = frames.findIndex((m) => m.type === "system" && m.subtype === "compact_boundary");
  const next = frames.findIndex((m, i) => i > cut && m.type === "result");
  const list = frames.slice(0, next + 1).filter((m) => m.type !== "probe_context_usage");
  const st = replay(list, undefined, () => Promise.reject(new Error("gone")));
  await Bun.sleep(0);
  expect(st.context).toBeUndefined();
  expect(replay(list).context).toBeUndefined();
});

test("a subagent's messages are its own: the main session's context ignores them", () => {
  const frames = fixture("subagent.jsonl");
  const main = frames.filter((m) => m.type === "assistant" && !m.parent_tool_use_id && !String(m.message.model).startsWith("<")).at(-1);
  expect(frames.some((m) => m.type === "assistant" && m.parent_tool_use_id)).toBe(true);
  expect(replay(frames).context).toEqual({ used: contextUsed(main.message.usage), total: 1_000_000 });
});

test("local command replies (zero usage) don't blank or move the context", () => {
  const frames = fixture("context.jsonl");
  const last = frames.findIndex((m) => m.type === "assistant" && m.message.model === "<synthetic>");
  expect(replay(frames.slice(0, last + 1)).context).toEqual({ used: 29557, total: 1_000_000 });
});

test("the window is the model's own among several in a result (a background call used another)", () => {
  noteWindows({ "claude-haiku-5-5": { contextWindow: 1_000_000 }, "claude-haiku-4-5-20251001": { contextWindow: 200_000 } }, "s", "claude-haiku-4-5-20251001");
  expect(contextOf(33_576, "claude-haiku-4-5-20251001", "s")).toEqual({ used: 33_576, total: 200_000 });
});

test("a session's reported window beats the model's, which beats the catalog; unknown is nothing", () => {
  catalog({ m: 1_000_000 });
  expect(contextOf(1000, "m", "new")).toEqual({ used: 1000, total: 1_000_000 });
  noteWindows({ m: { contextWindow: 200_000 } }, "a", "m");
  expect(contextOf(1000, "m", "new")!.total).toBe(200_000);
  noteWindows({ m: { contextWindow: 300_000 } }, "b", "m");
  expect(contextOf(1000, "m", "a")!.total).toBe(200_000);
  expect(contextOf(1000, "unlisted", "x")).toBeUndefined();
});

test("a count over the window is no number at all", () => {
  noteWindows({ m: { contextWindow: 200_000 } }, "a", "m");
  expect(contextOf(200_001, "m", "a")).toBeUndefined();
});

test("reported windows survive a restart, in a file of their own", () => {
  const f = join(mkdtempSync(join(tmpdir(), "tether-windows-")), "w.json");
  windowsIn(f);
  noteWindows({ m: { contextWindow: 200_000 } }, "a", "m");
  windowsIn(f);
  expect(contextOf(10, "m", "a")).toEqual({ used: 10, total: 200_000 });
});

const store = async () => (await readStore(join(import.meta.dir, "fixtures", "store", "context.jsonl"))).chain();

test("stored: the last main-thread message; without a window, nothing", async () => {
  const chain = await store();
  expect(chainContext(chain, FIRST)).toBeUndefined();
  catalog({ "claude-haiku-5-5": 1_000_000 });
  windowsIn(undefined);
  expect(chainContext(chain, FIRST)).toEqual({ used: 33_267, total: 1_000_000 });
});

test("stored: compacted with no message since, not known; not the old number", async () => {
  const chain = await store();
  catalog({ "claude-haiku-5-5": 1_000_000 });
  windowsIn(undefined);
  const at = chain.findIndex((e) => e.subtype === "compact_boundary");
  expect(chainContext(chain.slice(0, at + 1), FIRST)).toBeUndefined();
  expect(chainContext(chain.slice(0, at), FIRST)).toEqual({ used: 41_190, total: 1_000_000 });
});

test("stored: sidechain messages don't count", async () => {
  catalog({ m: 1000 });
  windowsIn(undefined);
  const a = (order: number, used: number, extra = {}) => ({ uuid: `${order}`, type: "assistant", order, message: { model: "m", usage: { input_tokens: used } }, ...extra });
  expect(chainContext([a(1, 100), a(2, 500, { isSidechain: true })], "s")).toEqual({ used: 100, total: 1000 });
});

// Real rate_limit_info from Claude Code 2.1.314, as recorded.
const WEEK_ONLY = { status: "allowed_warning", resetsAt: 1793901600, rateLimitType: "seven_day", utilization: 0.62, unifiedWindows: { seven_day: { utilization: 0.62, resetsAt: 1793901600, status: "allowed" } } };
const BOTH = { status: "allowed", resetsAt: 1793266800, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.05, resetsAt: 1793266800, status: "allowed" }, seven_day: { utilization: 0.36, resetsAt: 1793296800, status: "allowed" } } };

test("plan limits: what the event says, windows it doesn't name left out", () => {
  expect(planOf(WEEK_ONLY)).toEqual({ week: { percent: 62, resetsAt: 1793901600_000 } });
  expect(planOf(BOTH)).toEqual({ fiveHour: { percent: 5, resetsAt: 1793266800_000 }, week: { percent: 36, resetsAt: 1793296800_000 } });
  // An older CLI: the one window, at the top level.
  expect(planOf({ status: "allowed", rateLimitType: "five_hour", utilization: 0.5 })).toEqual({ fiveHour: { percent: 50 } });
  // A status with no number is no number.
  expect(planOf({ status: "allowed", resetsAt: 1, rateLimitType: "five_hour" })).toBeUndefined();
});

test("a rate_limit_event reports to the sink and is kept for stored sessions, merged", () => {
  const seen: any[] = [];
  const s = new ClaudeStream({ plan: (p: any) => seen.push(p), state() {} } as any, { nativeId: "n" });
  s.handle({ type: "rate_limit_event", rate_limit_info: BOTH });
  s.handle({ type: "rate_limit_event", rate_limit_info: WEEK_ONLY });
  s.handle({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
  expect(seen.length).toBe(2);
  expect(keptPlan()).toEqual({ fiveHour: { percent: 5, resetsAt: 1793266800_000, at: expect.any(Number) }, week: { percent: 62, resetsAt: 1793901600_000, at: expect.any(Number) } });
});

// accountInfo as Claude Code 2.1.314 really reports it, in each environment.
test("billing, from what accountInfo reports", () => {
  expect(claudeBilling({ subscriptionType: "Claude Ultra", apiProvider: "firstParty", email: "x", organization: "y" })).toEqual({ kind: "plan", label: "Claude plan" });
  expect(claudeBilling({ tokenSource: "claude.ai", apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" })).toEqual({ kind: "apiKey", label: "Anthropic API key" });
  expect(claudeBilling({ tokenSource: "ANTHROPIC_AUTH_TOKEN", apiProvider: "firstParty" })).toEqual({ kind: "apiKey", label: "Anthropic auth token" });
  expect(claudeBilling({ apiProvider: "bedrock" })).toEqual({ kind: "provider", label: "Amazon Bedrock" });
  expect(claudeBilling({ apiProvider: "vertex" })).toEqual({ kind: "provider", label: "Google Vertex" });
  expect(claudeBilling({ apiProvider: "foundry" })).toEqual({ kind: "provider", label: "Microsoft Foundry" });
  expect(claudeBilling({ apiProvider: "firstParty" }).kind).toBe("unknown");
  expect(claudeBilling({ apiProvider: "something-new" }).kind).toBe("unknown");
  expect(claudeBilling(undefined).kind).toBe("unknown");
});

test("billing is kept per session, and a start in the TUI leaves it unknown", () => {
  expect(keptBilling("s").kind).toBe("unknown");
  keepBilling("s", { kind: "plan", label: "Claude plan" });
  expect(keptBilling("s")).toEqual({ kind: "plan", label: "Claude plan" });
  expect(keptBilling("other").kind).toBe("unknown");
  forgetBilling("s");
  expect(keptBilling("s").kind).toBe("unknown");
});
