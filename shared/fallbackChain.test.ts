import { describe, expect, test } from "bun:test";
import { fallbackStepProblem, sameStep, type FallbackHarness, type FallbackStep } from "./fallbackChain";

const claudeCatalog: FallbackHarness = {
  harness: "claude",
  defaultMode: "plan",
  sources: [
    { source: "subscription", billing: { kind: "plan", label: "Claude plan" } },
    {
      source: "bedrock",
      billing: { kind: "provider", label: "Amazon Bedrock" },
      deployments: [
        { name: "us.anthropic.claude-sonnet-4-6-v1:0", model: "sonnet" },
        { name: "us.anthropic.claude-custom-v1:0" }, // alias-less Bedrock ID (G5)
      ],
    },
  ],
  models: {
    models: [
      { id: "sonnet", label: "Sonnet", efforts: ["low", "high"] },
      { id: "haiku", label: "Haiku" },
    ],
    efforts: [{ id: "low", label: "Low" }, { id: "high", label: "High" }],
    permissionModes: [{ id: "plan", label: "Plan" }],
  },
};

describe("fallbackStepProblem", () => {
  test("Bedrock model that doesn't resolve returns 'Not set up on Bedrock.'", () => {
    const step: FallbackStep = { harness: "claude", source: "bedrock", model: "haiku", permissionMode: "plan" };
    expect(fallbackStepProblem(step, claudeCatalog)).toBe("Not set up on Bedrock.");
  });

  test("Bedrock accepts both alias and alias-less Bedrock model IDs (G5)", () => {
    expect(fallbackStepProblem({ harness: "claude", source: "bedrock", model: "sonnet", effort: "high", permissionMode: "plan" }, claudeCatalog)).toBeUndefined();
    expect(fallbackStepProblem({ harness: "claude", source: "bedrock", model: "us.anthropic.claude-sonnet-4-6-v1:0", effort: "high", permissionMode: "plan" }, claudeCatalog)).toBeUndefined();
    expect(fallbackStepProblem({ harness: "claude", source: "bedrock", model: "us.anthropic.claude-custom-v1:0", permissionMode: "plan" }, claudeCatalog)).toBeUndefined();
  });

  test("Bedrock validates effort against catalog efforts and aliased model efforts", () => {
    expect(fallbackStepProblem({ harness: "claude", source: "bedrock", model: "us.anthropic.claude-sonnet-4-6-v1:0", effort: "max", permissionMode: "plan" }, claudeCatalog)).toBe("Effort unavailable for this model.");
    expect(fallbackStepProblem({ harness: "claude", source: "bedrock", model: "us.anthropic.claude-custom-v1:0", effort: "high", permissionMode: "plan" }, claudeCatalog)).toBeUndefined();
  });

  test("G10': probe === 'signedOut' returns 'Signed out', while probe === 'unknown' is eligible", () => {
    const accOut = "account:11111111-1111-4111-8111-111111111111" as const;
    const accUnk = "account:22222222-2222-4222-8222-222222222222" as const;
    const cat: FallbackHarness = {
      ...claudeCatalog,
      sources: [
        ...claudeCatalog.sources,
        { source: accOut, billing: { kind: "plan", label: "Claude plan · 11111111", source: accOut }, probe: "signedOut" },
        { source: accUnk, billing: { kind: "plan", label: "Claude plan · 22222222", source: accUnk }, probe: "unknown" },
      ],
    };
    expect(fallbackStepProblem({ harness: "claude", source: accOut, model: "sonnet", permissionMode: "plan" }, cat)).toBe("Signed out");
    expect(fallbackStepProblem({ harness: "claude", source: accUnk, model: "sonnet", permissionMode: "plan" }, cat)).toBeUndefined();
  });
});

describe("sameStep (O6)", () => {
  test("treats empty effort/mode as equal to resolved defaults and distinguishes harnesses", () => {
    const a: FallbackStep = { harness: "claude", source: "subscription", model: "sonnet" };
    const b: FallbackStep = { harness: "claude", source: "subscription", model: "sonnet", effort: "high", permissionMode: "plan" };
    expect(sameStep(a, b, { effort: "high", permissionMode: "plan" })).toBe(true);
    expect(sameStep(a, { ...b, harness: "codex" }, { effort: "high", permissionMode: "plan" })).toBe(false);
    expect(sameStep(a, { ...b, effort: "low" }, { effort: "high", permissionMode: "plan" })).toBe(false);
  });
});
