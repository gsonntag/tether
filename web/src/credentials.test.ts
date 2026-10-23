import { afterEach, describe, expect, test } from "bun:test";
import { clearSlots, registerSlot, slotFor } from "./credentials";
import { chainLabel, credentialName, forgetAliases, learnCredentials, modelLabel, orderLabel } from "./models";
import { entryProblem } from "./shared/defaultOrder";
import { isCredentialId } from "./shared/credentials";
import { formatEntry, modelKey, parseEntry } from "./shared/protocol";

afterEach(() => {
  forgetAliases();
  clearSlots();
});

describe("credential entries", () => {
  test("ids are provider:name", () => {
    expect(isCredentialId("azure:east-coast")).toBe(true);
    expect(isCredentialId("anthropic:gavin@example.com")).toBe(true);
    expect(isCredentialId("azure")).toBe(false);
    expect(isCredentialId("Azure:east")).toBe(false);
    expect(isCredentialId("azure:a#b")).toBe(false);
  });

  test("a picker's key is the model with its credential, and reads back as an entry", () => {
    expect(modelKey({ id: "gpt-6-luna" })).toBe("gpt-6-luna");
    const key = modelKey({ id: "gpt-6-luna", credential: "azure:east" });
    expect(formatEntry(parseEntry(key, "codex"))).toBe("codex:gpt-6-luna#azure:east");
  });

  test("entryProblem checks the credential's shape, and that it exists when told the runner's", () => {
    expect(entryProblem("pi:azure/gpt-6-luna#azure:east")).toBeUndefined();
    expect(entryProblem("pi:azure/gpt-6-luna#east")).toMatch(/isn't one/);
    expect(entryProblem("pi:azure/gpt-6-luna#azure:east", new Set())).toMatch(/isn't on this runner/);
  });
});

describe("labels", () => {
  test("Model · Provider, by the name learned from model lists over the Credentials page's", () => {
    expect(modelLabel({ id: "gpt-6-luna", credential: "azure:east" }, "codex")).toBe("GPT-6 Luna · east");
    learnCredentials([{ credential: "azure:east", credentialLabel: "Microsoft Foundry · east-coast" }], true);
    expect(credentialName("azure:east")).toBe("Microsoft Foundry · east-coast");
    expect(learnCredentials([{ credential: "azure:east", credentialLabel: "Azure" }])).toBe(true);
    expect(learnCredentials([{ credential: "azure:east", credentialLabel: "Other" }], true)).toBe(false);
    expect(modelLabel({ id: "gpt-6-luna", credential: "azure:east" }, "codex")).toBe("GPT-6 Luna · Azure");
    expect(modelLabel({ id: "gpt-6-luna", credential: "azure:east", credentialLabel: "Azure (azure-sol)" }, "codex")).toBe("GPT-6 Luna · Azure (azure-sol)");
    expect(chainLabel(["codex:gpt-6-luna#azure:east", "codex:gpt-6-luna"])).toBe("GPT-6 Luna · Azure → GPT-6 Luna");
    expect(orderLabel(["codex:gpt-6-luna#azure:east"])).toBe("GPT-6 Luna · Azure (Codex)");
  });
});

describe("slot registry", () => {
  test("one slot per provider; unknown providers have none", () => {
    registerSlot({ provider: "example", actionLabels: { signIn: "Sign in" } });
    expect(slotFor("example")?.actionLabels).toEqual({ signIn: "Sign in" });
    expect(slotFor("azure")).toBeUndefined();
  });
});
