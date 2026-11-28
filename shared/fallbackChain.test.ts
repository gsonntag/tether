import { describe, expect, test } from "bun:test";
import { fallbackStepProblem, type FallbackHarness, type FallbackStep } from "./fallbackChain";

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
});
