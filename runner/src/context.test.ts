import { describe, expect, test } from "bun:test";
import {
  acpUsage,
  agyUsage,
  anthropicUsage,
  claudeContextUsage,
  claudeHistoryContext,
  claudeWindow,
  codexRollout,
  codexTokenUsage,
  knownWindow,
  mergeContext,
  piStats,
  switchModel,
  withKnownMax,
} from "./context";

describe("knownWindow", () => {
  test("1M variants", () => {
    expect(knownWindow("claude-sonnet-4-5[1m]")).toBe(1_000_000);
    expect(knownWindow("opus[1m]")).toBe(1_000_000);
  });
  test("Claude families", () => {
    expect(knownWindow("claude-sonnet-4-5-20250929")).toBe(200_000);
    expect(knownWindow("claude-3-5-sonnet-20241022")).toBe(200_000);
    expect(knownWindow("claude-opus-4-6-thinking")).toBe(200_000);
    expect(knownWindow("claude-opus-5-5")).toBe(1_000_000);
    expect(knownWindow("anthropic/claude-haiku-5-5")).toBe(1_000_000);
  });
  test("others", () => {
    expect(knownWindow("gemini-3.1-pro-high")).toBe(1_048_576);
    expect(knownWindow("google/gemini-2.5-flash")).toBe(1_048_576);
    expect(knownWindow("gpt-oss-120b-medium")).toBe(131_072);
    expect(knownWindow("openai-codex/gpt-5.2-codex")).toBe(272_000);
  });
  test("unknown or bare aliases", () => {
    expect(knownWindow("opus")).toBeUndefined();
    expect(knownWindow("default")).toBeUndefined();
    expect(knownWindow("gpt-6.1-sol")).toBeUndefined();
    expect(knownWindow(undefined)).toBeUndefined();
  });
});

describe("withKnownMax / switchModel", () => {
  test("fills an unknown window from the name", () =>
    expect(withKnownMax({ used: 10, model: "gemini-3.8-flash-high" })).toEqual({ used: 10, model: "gemini-3.8-flash-high", max: 1_048_576, maxEstimated: true }));
  test("keeps a reported window", () => expect(withKnownMax({ used: 10, max: 5, model: "gemini-x" })).toEqual({ used: 10, max: 5, model: "gemini-x" }));
  test("model switch keeps the size, takes the new window", () =>
    expect(switchModel({ used: 50_000, max: 1_000_000, model: "claude-opus-5-5" }, "claude-sonnet-4-5")).toEqual({
      used: 50_000,
      max: 200_000,
      model: "claude-sonnet-4-5",
      maxEstimated: true,
    }));
  test("unknown new window keeps the old one", () => expect(switchModel({ used: 1, max: 258_400, model: "gpt-6-sol" }, "gpt-6-luna")?.max).toBe(258_400));
  test("merge: a request's usage keeps the reported window", () =>
    expect(mergeContext({ used: 10, max: 1_000_000, model: "claude-opus-5-5" }, { used: 20, input: 20, model: "claude-opus-5-5" })).toEqual({
      used: 20,
      input: 20,
      max: 1_000_000,
      model: "claude-opus-5-5",
    }));
  test("merge: a reported window replaces an estimate", () =>
    expect(mergeContext({ used: 10, max: 200_000, maxEstimated: true, model: "m" }, { max: 1_000_000, model: "m" })).toEqual({
      used: 10,
      max: 1_000_000,
      maxEstimated: undefined,
      model: "m",
    }));
  test("merge: another model drops the old window", () =>
    expect(mergeContext({ used: 10, max: 1_000_000, model: "claude-opus-5-5" }, { used: 30, model: "claude-sonnet-4-5" })).toEqual({
      used: 30,
      max: 200_000,
      maxEstimated: true,
      model: "claude-sonnet-4-5",
    }));
  test("same model is a no-op", () => {
    const c = { used: 1, model: "m" };
    expect(switchModel(c, "m")).toBe(c);
  });
});

describe("Claude Code", () => {
  test("message_start usage: input + cache read + cache write", () =>
    expect(
      anthropicUsage(
        { input_tokens: 2, cache_creation_input_tokens: 14224, cache_read_input_tokens: 69034, output_tokens: 6, cache_creation: { ephemeral_1h_input_tokens: 14224 } },
        "claude-opus-5-5",
      ),
    ).toEqual({ used: 83_260, input: 2, cacheRead: 69034, cacheWrite: 14224, model: "claude-opus-5-5" }));
  test("no usage", () => expect(anthropicUsage(undefined)).toBeUndefined());

  const modelUsage = {
    "claude-haiku-5-5": { inputTokens: 1170, contextWindow: 1_000_000, canonicalModel: "claude-haiku-5-5" },
    "claude-sonnet-4-5[1m]": { inputTokens: 2, contextWindow: 1_000_000 },
    "claude-opus-4-7": { inputTokens: 2, contextWindow: 200_000, canonicalModel: "claude-opus-4-7" },
  };
  test("result modelUsage: the main model's window, not the helper's", () => expect(claudeWindow(modelUsage, "claude-opus-4-7")).toBe(200_000));
  test("result modelUsage: [1m] key matches the plain API model id", () => expect(claudeWindow(modelUsage, "claude-sonnet-4-5")).toBe(1_000_000));
  test("result modelUsage: unknown model", () => expect(claudeWindow(modelUsage, "claude-sonnet-9")).toBeUndefined());

  test("stored session: the last main-thread reply, not a subagent's", () =>
    expect(
      claudeHistoryContext([
        { type: "assistant", parent_tool_use_id: null, message: { model: "claude-opus-5-5", usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 } } },
        { type: "user", message: { content: "x" } },
        { type: "assistant", parent_tool_use_id: null, message: { model: "claude-opus-5-5", usage: { input_tokens: 3, cache_read_input_tokens: 5000, cache_creation_input_tokens: 20 } } },
        { type: "assistant", parent_tool_use_id: "toolu_1", message: { model: "claude-haiku-5-5", usage: { input_tokens: 99, cache_read_input_tokens: 0 } } },
        { type: "system" },
      ]),
    ).toEqual({ used: 5023, input: 3, cacheRead: 5000, cacheWrite: 20, model: "claude-opus-5-5" }));
  test("stored session without replies", () => expect(claudeHistoryContext([{ type: "user" }])).toBeUndefined());
  test("getContextUsage before any request: estimate + window", () =>
    expect(claudeContextUsage({ totalTokens: 13915, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, model: "claude-opus-5-5", apiUsage: null })).toEqual({
      used: 13915,
      max: 1_000_000,
      model: "claude-opus-5-5",
    }));
  test("getContextUsage after a request: the API's numbers", () =>
    expect(
      claudeContextUsage({
        totalTokens: 90_000,
        rawMaxTokens: 200_000,
        model: "claude-opus-4-7",
        apiUsage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 80_000 },
      }),
    ).toEqual({ used: 80_110, input: 10, cacheRead: 80_000, cacheWrite: 100, max: 200_000, model: "claude-opus-4-7" }));
});

describe("Codex", () => {
  const usage = {
    total: { totalTokens: 139099, inputTokens: 137898, cachedInputTokens: 122624, cacheWriteInputTokens: 0, outputTokens: 1201, reasoningOutputTokens: 681 },
    last: { totalTokens: 30802, inputTokens: 30762, cachedInputTokens: 29440, cacheWriteInputTokens: 0, outputTokens: 40, reasoningOutputTokens: 11 },
    modelContextWindow: 258400,
  };
  test("thread/tokenUsage/updated: the last request, not the total", () =>
    expect(codexTokenUsage(usage, "gpt-6-sol")).toEqual({ used: 30762, input: 1322, cacheRead: 29440, cacheWrite: undefined, max: 258400, model: "gpt-6-sol" }));
  test("no window", () => expect(codexTokenUsage({ ...usage, modelContextWindow: null })?.max).toBeUndefined());
  test("nothing", () => expect(codexTokenUsage(undefined)).toBeUndefined());

  const tc = (input: number) =>
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 999999 },
          last_token_usage: { input_tokens: input, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 40, total_tokens: input + 40 },
          model_context_window: 258400,
        },
      },
    });
  test("rollout: the last token count", () =>
    expect(codexRollout(["partial line…", tc(5000), '{"type":"response_item"}', tc(7000), ""].join("\n"), "gpt-6-sol")).toEqual({
      used: 7000,
      input: 6000,
      cacheRead: 1000,
      cacheWrite: undefined,
      max: 258400,
      model: "gpt-6-sol",
    }));
  test("rollout: compacted after the last count", () => {
    const c = codexRollout([tc(200_000), '{"type":"compacted","payload":{"message":""}}'].join("\n"));
    expect(c?.used).toBeUndefined();
    expect(c?.max).toBe(258400);
  });
  test("rollout: count after compaction", () =>
    expect(codexRollout([tc(200_000), '{"type":"compacted","payload":{}}', tc(20_000)].join("\n"))?.used).toBe(20_000));
  test("rollout: none", () => expect(codexRollout('{"type":"session_meta"}')).toBeUndefined());
});

describe("pi", () => {
  test("get_session_stats contextUsage", () =>
    expect(piStats({ tokens: { total: 105000 }, contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 } }, "anthropic/claude-sonnet-4-5")).toEqual({
      used: 60000,
      max: 200000,
      model: "anthropic/claude-sonnet-4-5",
    }));
  test("right after compaction tokens are null", () => expect(piStats({ contextUsage: { tokens: null, contextWindow: 200000, percent: null } })).toEqual({ used: undefined, max: 200000 }));
  test("no model", () => expect(piStats({ tokens: {} })).toBeUndefined());
});

describe("ACP", () => {
  test("usage_update", () => expect(acpUsage({ sessionUpdate: "usage_update", used: 42000, size: 200000, cost: { amount: 0.1 } }, "m")).toEqual({ used: 42000, max: 200000, model: "m" }));
  test("empty", () => expect(acpUsage({})).toBeUndefined());
});

describe("Antigravity", () => {
  test("step usage", () =>
    expect(agyUsage({ input_tokens: 11773, output_tokens: 28, thinking_tokens: 27, cache_read_tokens: 4000, total_tokens: 11801 }, "gemini-3.1-pro-high")).toEqual({
      used: 15773,
      input: 11773,
      cacheRead: 4000,
      model: "gemini-3.1-pro-high",
    }));
  test("no cache read", () => expect(agyUsage({ input_tokens: 10, cache_read_tokens: 0 })).toEqual({ used: 10, input: 10, cacheRead: undefined }));
});
