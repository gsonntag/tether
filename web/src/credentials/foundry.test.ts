import { describe, expect, test } from "bun:test";
import { foundryModels, foundrySlot } from "./foundry";
import { modelDisplay, modelLabel } from "../models";
import type { CredentialView } from "../shared/credentials";

const view: CredentialView = {
  id: "azure:east-coast-gavin-resource",
  kind: "apiKey",
  provider: "azure",
  label: "east-coast-gavin-resource",
  source: "shell",
  state: "ok",
  models: [
    { harness: "codex", id: "gpt-6.1-sol", label: "azure-sol", credentialLabel: "Azure" },
    { harness: "pi", id: "azure/gpt-6.1-sol", label: "azure-sol", credentialLabel: "Azure" },
    { harness: "codex", id: "gpt-6-mini", credentialLabel: "Azure" },
  ],
};

describe("Foundry slot", () => {
  test("a resource's models: one per deployment, its Codex profile when it has one", () => {
    expect(foundryModels(view)).toEqual([
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", profile: "azure-sol" },
      { id: "gpt-6-mini", name: expect.any(String) },
    ]);
  });

  test("labels read “GPT-6.1 Sol · Azure”; Store in Tether is a row button, the rest are its own", () => {
    expect(modelLabel({ id: "gpt-6.1-sol", credential: view.id, credentialLabel: "Azure" }, "codex")).toBe("GPT-6.1 Sol · Azure");
    expect(foundrySlot.actionLabels?.storeKey).toBe("Store in Tether");
    expect(foundrySlot.ownActions).toEqual(expect.arrayContaining(["addModel", "replaceKey", "removeModel"]));
    expect(foundrySlot.ownActions).not.toContain("storeKey");
  });

  test("a second Codex profile on one deployment reads with its profile", () => {
    expect(modelDisplay("gpt-6-luna@azure-luna-low", "codex").name).toBe("GPT-6 Luna (azure-luna-low)");
    expect(modelDisplay("@cf/meta/llama-3", "opencode").name).not.toContain("(");
  });
});
