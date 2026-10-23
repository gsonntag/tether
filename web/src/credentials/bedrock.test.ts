// Bedrock models read like the same model on a subscription, with the credential after it.

import { expect, test } from "bun:test";
import { modelLabel } from "../models";

test("Bedrock ids and inference profiles read “Opus 5.5 · Bedrock”", () => {
  const on = (id: string, harness: string) => modelLabel({ id, credential: "bedrock:aws.default", credentialLabel: "Bedrock" }, harness);
  expect(on("us.anthropic.claude-opus-5-5", "claude-code")).toBe("Opus 5.5 · Bedrock");
  expect(on("amazon-bedrock/us.anthropic.claude-opus-5-5", "pi")).toBe("Opus 5.5 · Bedrock");
  expect(on("anthropic.claude-sonnet-5", "claude-code")).toBe("Sonnet 5 · Bedrock");
});
