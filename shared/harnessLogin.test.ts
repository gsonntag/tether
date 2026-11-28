import { describe, expect, test } from "bun:test";
import { missingSourceLabel, sourceLabel, type AccountSource } from "./credentials";
import { accountDisplayLabel, normalizedOrganization } from "./harnessLogin";

describe("normalizedOrganization (G9)", () => {
  test("handles undefined email without throwing and strips whitespace/curly apostrophes", () => {
    expect(normalizedOrganization("Acme Corp")).toBe("AcmeCorp");
    expect(normalizedOrganization("Acme Corp", undefined)).toBe("AcmeCorp");
    expect(normalizedOrganization("Alice’s Org", undefined)).toBe("Alice'sOrg");
    expect(normalizedOrganization("a@example.test’s Organization", "A@Example.Test")).toBe("a@example.test'sorganization");
  });
});

describe("accountDisplayLabel (G9)", () => {
  test("name precedence: displayName > email > organization > fallback", () => {
    expect(accountDisplayLabel({ state: "signedIn", displayName: "Work", email: "a@x.test", organization: "Acme", plan: "Max" }, "Fallback"))
      .toEqual({ name: "Work", detail: "Max · Acme" });
    expect(accountDisplayLabel({ state: "signedIn", email: "a@x.test", organization: "Acme", plan: "Pro" }, "Fallback"))
      .toEqual({ name: "a@x.test", detail: "Pro · Acme" });
    expect(accountDisplayLabel({ state: "signedIn", organization: "Acme", plan: "Max" }, "Fallback"))
      .toEqual({ name: "Acme", detail: "Max" });
    expect(accountDisplayLabel({ state: "signedIn", plan: "Max" }, "Fallback"))
      .toEqual({ name: "Fallback", detail: "Max" });
    expect(accountDisplayLabel({ state: "signedOut" }, "Fallback")).toEqual({ name: "Fallback" });
    expect(accountDisplayLabel(undefined, "Fallback")).toEqual({ name: "Fallback" });
  });

  test("omits personal-default org, omits org when name came from org, keeps plan as given, drops generic Claude plan", () => {
    expect(accountDisplayLabel({
      state: "signedIn",
      email: "a@x.test",
      organization: "a@x.test’s Organization",
      plan: "pro",
    }, "Claude plan")).toEqual({ name: "a@x.test", detail: "pro" });

    expect(accountDisplayLabel({
      state: "signedIn",
      email: "a@x.test",
      organization: "a@x.test's Organization",
      plan: "Claude plan",
    }, "Claude plan")).toEqual({ name: "a@x.test" });

    // Org not repeated when name already came from org.
    expect(accountDisplayLabel({
      state: "signedIn",
      organization: "Acme Team",
    }, "Claude plan")).toEqual({ name: "Acme Team" });
  });
});

describe("sourceLabel & missingSourceLabel (G8)", () => {
  const acc: AccountSource = "account:3f2a9c1e-1111-4222-8333-444444444444";

  test("returns runner-style opaque labels", () => {
    expect(sourceLabel("claude", "subscription")).toBe("Claude plan");
    expect(sourceLabel("claude", acc)).toBe("Claude plan · 3f2a9c1e");
    expect(sourceLabel("claude", "anthropic")).toBe("Anthropic API key");
    expect(sourceLabel("codex", "subscription")).toBe("ChatGPT plan");
    expect(sourceLabel("codex", "openai")).toBe("OpenAI API key");
    expect(sourceLabel("codex", "azure")).toBe("Azure");
    expect(sourceLabel("claude", "bedrock")).toBe("Amazon Bedrock");
  });

  test("returns readable missing-source labels with no raw account ids", () => {
    expect(missingSourceLabel("claude", acc)).toBe("Removed Claude account");
    expect(missingSourceLabel("codex", "azure")).toBe("Azure (not set up)");
    expect(missingSourceLabel("claude", "bedrock")).toBe("Bedrock (not set up)");
    expect(missingSourceLabel("claude", "anthropic")).toBe("Anthropic key (not set)");
    expect(missingSourceLabel("codex", "openai")).toBe("OpenAI key (not set)");
    expect(missingSourceLabel("claude", "subscription")).toBe("Claude Code login unavailable");
  });
});
