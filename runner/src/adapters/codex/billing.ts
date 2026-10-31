/** An account can remain signed in to ChatGPT while provider overrides select a key. Verify the
 * provider's authentication path too; account/read by itself is not billing confirmation. */
export function confirmSubscriptionProvider(provider: unknown, account: any, config: any): void {
  const fail = () => { throw new Error("Codex could not confirm the ChatGPT subscription's authentication path. Nothing was sent."); };
  if (provider !== "openai" || account?.type !== "chatgpt" || !config || typeof config !== "object") return fail();
  const providers = config.model_providers;
  if (providers !== undefined && (!providers || typeof providers !== "object" || Array.isArray(providers))) return fail();
  const own = providers?.openai;
  if (own === undefined) return; // The built-in OpenAI provider uses first-party account auth.
  if (!own || typeof own !== "object" || own.requires_openai_auth !== true) return fail();
  for (const key of ["env_key", "experimental_bearer_token", "auth", "aws"]) if (own[key] !== undefined && own[key] !== null) return fail();
  if (own.base_url !== undefined && own.base_url !== null && !["https://api.openai.com/v1", "https://chatgpt.com/backend-api/codex", "https://chat.openai.com/backend-api/codex"].includes(String(own.base_url).replace(/\/$/, ""))) return fail();
  for (const field of ["http_headers", "env_http_headers", "query_params"]) {
    const values = own[field];
    if (values && Object.keys(values).some((key) => /^(authorization|api[-_]?key|x-api-key|access_token)$/i.test(key))) return fail();
  }
}
