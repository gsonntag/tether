import { describe, expect, test } from "bun:test";
import { chainLabel, effortLabel, modelDisplay } from "./models";

const name = (id: string, harness?: string) => modelDisplay(id, harness).name;

describe("modelDisplay", () => {
  test.each([
    // Claude Code aliases and ids
    ["default", "Default"],
    ["opus", "Opus"],
    ["opus[1m]", "Opus 1M"],
    ["sonnet[1m]", "Sonnet 1M"],
    ["opusplan", "Opus Plan"],
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-opus-5-5[1m]", "Opus 5.5 1M"],
    ["claude-sonnet-4-20250514", "Sonnet 4"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"],
    ["claude-3-5-sonnet-20241022", "Sonnet 3.5"],
    ["claude-fable-5-1", "Fable 5.1"],
    ["claude-opus-4-6-thinking", "Opus 4.6 Thinking"],
    // Codex / OpenAI
    ["gpt-5.5", "GPT-5.5"],
    ["gpt-5.3-codex", "GPT-5.3 Codex"],
    ["gpt-5.3-codex-spark", "GPT-5.3 Codex Spark"],
    ["gpt-6-luna", "GPT-6 Luna"],
    ["gpt-4o-mini", "GPT-4o Mini"],
    ["gpt-4o-2024-08-06", "GPT-4o"],
    ["gpt-5-chat-latest", "GPT-5 Chat"],
    ["gpt-oss-120b", "GPT-OSS 120B"],
    ["o3-mini", "o3 Mini"],
    ["gpt-daybreak-blue-latest", "Daybreak Blue"],
    // Antigravity (effort baked into the id)
    ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
    ["gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)"],
    ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
    // pi: provider/id
    ["openai-codex/gpt-6-luna", "GPT-6 Luna"],
    ["anthropic/claude-opus-5-5", "Opus 5.5"],
    ["github-copilot/claude-opus-5.5", "Opus 5.5"],
    ["google/gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"],
    ["google/gemma-4-26b-a4b-it", "Gemma 4 26B A4B IT"],
    ["xai/grok-4.7", "Grok 4.7"],
    ["moonshotai/kimi-k2.7-code", "Kimi K2.7 Code"],
    ["zai/glm-5.3-highspeed", "GLM-5.3 Highspeed"],
    ["qwen-token-plan/qwen3.8-max", "Qwen3.8 Max"],
    ["deepseek/deepseek-v4-pro", "DeepSeek V4 Pro"],
    ["minimax/MiniMax-M2.7", "MiniMax M2.7"],
    ["mistral/devstral-medium-latest", "Devstral Medium"],
    ["mistral/zai-glm-5-2", "GLM-5.2"],
    ["huggingface/meta-llama/Llama-3.1-8B-Instruct", "Llama 3.1 8B Instruct"],
    // Bedrock: region + vendor dot prefixes, version suffixes
    ["amazon-bedrock/us.anthropic.claude-opus-5-5", "Opus 5.5"],
    ["amazon-bedrock/eu.anthropic.claude-sonnet-4-5-20250929-v1:0", "Sonnet 4.5"],
    ["amazon-bedrock/anthropic.claude-opus-4-6-v1", "Opus 4.6"],
    ["us.anthropic.claude-opus-5-5-v1:0", "Opus 5.5"],
    ["amazon-bedrock/meta.llama3-1-70b-instruct-v1:0", "Llama 3.1 70B Instruct"],
    ["amazon-bedrock/us-gov.openai.gpt-oss-20b-1:0", "GPT-OSS 20B"],
    ["amazon-bedrock/deepseek.v3-v1:0", "DeepSeek V3"],
    ["amazon-bedrock/writer.palmyra-x5-v1:0", "Palmyra X5"],
    ["amazon-bedrock/us.amazon.nova-premier-v1:0", "Nova Premier"],
    // unknown ids still come out readable
    ["thinkingmachines/inkling-small", "Inkling Small"],
    ["some-new-model-7-2", "Some New Model 7.2"],
  ])("%s → %s", (id, want) => expect(name(id)).toBe(want));

  test("makers and logos", () => {
    expect(modelDisplay("claude-opus-5-5")).toMatchObject({ provider: "anthropic", providerLabel: "Anthropic", logo: "/logos/anthropic.svg" });
    expect(modelDisplay("gpt-5.3-codex").provider).toBe("openai");
    expect(modelDisplay("gemini-3.8-flash-high").logo).toBe("/logos/google.svg");
    expect(modelDisplay("amazon-bedrock/global.xai.grok-4.7").provider).toBe("xai");
    expect(modelDisplay("qwen-token-plan/kimi-k2.6").provider).toBe("moonshot");
    expect(modelDisplay("inkling").provider).toBeUndefined();
  });

  test("routes are kept as via, makers are not", () => {
    expect(modelDisplay("openai-codex/gpt-6-luna").via).toBe("openai-codex");
    expect(modelDisplay("azure/gpt-5.5")).toMatchObject({ provider: "openai", via: "azure" });
    expect(modelDisplay("amazon-bedrock/us.anthropic.claude-opus-5-5").via).toBe("amazon-bedrock");
    expect(modelDisplay("anthropic/claude-opus-5-5").via).toBeUndefined();
    expect(modelDisplay("openrouter/anthropic/claude-opus-5-5")).toMatchObject({ provider: "anthropic", via: "openrouter", name: "Opus 5.5" });
  });

  test("the raw id is kept and the harness names makers of bare aliases", () => {
    expect(modelDisplay("opus[1m]").id).toBe("opus[1m]");
    expect(modelDisplay(undefined)).toMatchObject({ id: "default", name: "Default", provider: undefined });
    expect(modelDisplay("default", "claude-code").provider).toBe("anthropic");
    expect(modelDisplay("default", "codex").provider).toBe("openai");
    expect(modelDisplay("default", "pi").provider).toBeUndefined();
  });
});

test("chainLabel", () => {
  expect(chainLabel(["claude-code:opus", "codex:gpt-6-luna", "pi:anthropic/claude-sonnet-5-5"])).toBe("Opus → GPT-6 Luna → Sonnet 5.5");
  expect(chainLabel(["claude-opus-5-5"], "claude-code")).toBe("Opus 5.5");
  // the built-in fallback profiles: one model through two routes stays tell-apart-able
  expect(chainLabel(["pi:openai-codex/gpt-6-luna", "pi:azure/gpt-6-luna"])).toBe("GPT-6 Luna (openai-codex) → GPT-6 Luna (azure)");
  expect(chainLabel(["claude-code:opus", "pi:azure/gpt-6-luna"])).toBe("Opus → GPT-6 Luna");
});

test("effortLabel", () => {
  expect(["low", "medium", "high", "xhigh", "max", "minimal", "off", "none", "default"].map(effortLabel)).toEqual([
    "Low",
    "Medium",
    "High",
    "XHigh",
    "Max",
    "Minimal",
    "Off",
    "None",
    "Default",
  ]);
  expect(effortLabel("")).toBe("");
});
