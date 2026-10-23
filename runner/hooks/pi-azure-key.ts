// pi extension: make the Tether session's Microsoft Foundry key win over a key pi keeps itself.
// pi resolves its `azure` provider from a stored credential (~/.pi/agent/auth.json) before the
// AZURE_OPENAI_API_KEY env var (pi-ai auth/helpers.js envApiKeyAuth), so a session on a Tether
// credential would quietly run on pi's own key. A runtime API key is pi's non-persistent override
// (core/runtime-credentials.js: read() prefers it; auth.json is never written). The model runtime
// isn't public extension API, so this reaches it through the model registry and says so in the
// session when it can't. Loaded by the runner with `pi -e <this file>` (credentials/foundry.ts).
export default function (pi: any) {
  const key = process.env.AZURE_OPENAI_API_KEY;
  // Set by the runner with the key (an AZURE_* name: the only env a Foundry credential may set).
  if (!key || process.env.AZURE_TETHER_SESSION_KEY !== "1") return;
  delete process.env.AZURE_TETHER_SESSION_KEY;
  pi.on("session_start", async (_event: any, ctx: any) => {
    const runtime = ctx?.modelRegistry?.runtime;
    try {
      if (typeof runtime?.setRuntimeApiKey !== "function") throw new Error("this pi has no runtime API keys");
      await runtime.setRuntimeApiKey("azure", key);
      // Held by pi now: the commands its tools run don't inherit it.
      delete process.env.AZURE_OPENAI_API_KEY;
    } catch (e: any) {
      ctx?.ui?.notify?.(`Tether couldn't hand pi this session's Azure key (${e?.message ?? e}); pi's own azure key, if it has one, is used.`, "warning");
    }
  });
}
