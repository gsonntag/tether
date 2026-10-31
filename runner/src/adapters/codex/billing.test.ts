import { expect, test } from "bun:test";
import { confirmSubscriptionProvider } from "./billing";

test("cached ChatGPT account cannot conceal a provider key or alternate auth path", () => {
  const account = { type: "chatgpt" };
  expect(() => confirmSubscriptionProvider("openai", account, {})).not.toThrow();
  expect(() => confirmSubscriptionProvider("openai", account, { model_providers: { openai: { requires_openai_auth: true } } })).not.toThrow();
  for (const patch of [{ env_key: "OPENAI_API_KEY" }, { experimental_bearer_token: "configured" }, { auth: {} }, { aws: {} }, { requires_openai_auth: false }, { base_url: "https://proxy.example/v1" }, { http_headers: { Authorization: "configured" } }, { env_http_headers: { "api-key": "AZURE_KEY" } }]) {
    expect(() => confirmSubscriptionProvider("openai", account, { model_providers: { openai: { requires_openai_auth: true, ...patch } } })).toThrow("Nothing was sent");
  }
  for (const args of [["azure", account, {}], ["openai", null, {}], ["openai", { type: "apiKey" }, {}], ["openai", account, undefined]] as const) expect(() => confirmSubscriptionProvider(args[0], args[1], args[2])).toThrow("Nothing was sent");
});
