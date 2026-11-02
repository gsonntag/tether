import { afterAll, expect, test } from "bun:test";
import { deploymentPricing } from "./privateHost";
import { testAzure, upstreamHeaders, upstreamUrl } from "./upstream";

const key = `fake-azure-${crypto.randomUUID()}`;
const seen: { path: string; apiKey: string | null; auth: string | null; body: any }[] = [];
let answer: () => Response = () => Response.json({ id: "r", model: "gpt-6-luna-2026-10-01", output: [] });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { seen.push({ path: new URL(req.url).pathname, apiKey: req.headers.get("api-key"), auth: req.headers.get("authorization"), body: await req.json().catch(() => null) }); return answer(); } });
afterAll(() => server.stop(true));
const endpoint = `http://127.0.0.1:${server.port}/openai/v1`;
const snap = { source: "azure" as const, revision: "r", key, endpoint, deployment: "d-one" };

test("Test sends one tiny request where a session's go, with the key only in api-key, and answers in a few words", async () => {
  expect(await testAzure(snap)).toEqual({ ok: true, text: "OK · gpt-6-luna-2026-10-01" });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ path: "/openai/v1/responses", apiKey: key, auth: null });
  expect(seen[0]!.body).toMatchObject({ model: "d-one", max_output_tokens: 16 });
  const cases: [Response, string][] = [
    [new Response(`bad ${key}`, { status: 401 }), "Key rejected"],
    [Response.json({ error: { code: "DeploymentNotFound", message: key } }, { status: 404 }), "Deployment not found"],
    [new Response("", { status: 429 }), "Rate limited"],
    [Response.json({ error: { code: "OperationNotSupported", message: key } }, { status: 400 }), "HTTP 400 · OperationNotSupported"],
    [Response.json({ error: { code: key } }, { status: 400 }), "HTTP 400"],
    [Response.json({ model: `x ${key}` }), "OK"],
  ];
  for (const [res, text] of cases) {
    answer = () => res;
    const r = await testAzure(snap);
    expect(r.text).toBe(text);
    expect(JSON.stringify(r)).not.toContain(key);
  }
  expect(await testAzure(undefined)).toEqual({ ok: false, text: "Save it, with the key, first" });
  expect((await testAzure({ ...snap, endpoint: "http://127.0.0.1:1/openai/v1" })).text).toBe("Can't reach the endpoint");
});

test("the gateway's URL and headers are the session path's", () => {
  expect(upstreamUrl("https://r.openai.azure.com/openai/v1/", "/responses?x=1")).toBe("https://r.openai.azure.com/openai/v1/responses?x=1");
  const h = upstreamHeaders("azure", key, { authorization: "Bearer local", "api-key": "other", "x-keep": "1" });
  expect([...h.entries()]).toEqual([["api-key", key], ["x-keep", "1"]]);
  expect(upstreamHeaders("openai", key).get("authorization")).toBe(`Bearer ${key}`);
});

test("a deployment's pricing prices only requests to it", () => {
  const rates = { model: "gpt-6-luna", type: "global" as const };
  expect(deploymentPricing(rates, "d-one", JSON.stringify({ model: "d-one" }))).toEqual(rates);
  expect(deploymentPricing(rates, "d-one", JSON.stringify({ model: "other" }))).toBeUndefined();
  expect(deploymentPricing(rates, "d-one", undefined)).toBeUndefined();
  expect(deploymentPricing(rates, undefined, JSON.stringify({ model: "other" }))).toEqual(rates);
  expect(deploymentPricing(undefined, "d-one", JSON.stringify({ model: "d-one" }))).toBeUndefined();
});
