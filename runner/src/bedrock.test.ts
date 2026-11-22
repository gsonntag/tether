import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStreamCodec } from "@smithy/core/event-streams";
import { accessAllows } from "../../shared/access";
import type { BedrockSettings } from "../../shared/credentials";
import { bedrockGateway, claudeBedrockLease } from "./bedrock";
import { BedrockSpend, noBedrockCharge, priceBedrock, unpricedBedrock } from "./bedrockCost";
import { CredentialStore } from "./credentials";
import { confirmClaudeBilling } from "./adapters/claude/credentials";
import { providerConfig } from "./adapters/codex/sources";

const key = "fixture-bedrock-key-not-real";
const sonnet = { id: "global.anthropic.claude-sonnet-4-6", harness: "claude" } as const;
const oss = { id: "openai.gpt-oss-120b", harness: "codex" } as const;
const settings: BedrockSettings = { region: "us-east-1", auth: "key", models: [sonnet, oss] };
const encoder = new TextEncoder();
const codec = new EventStreamCodec((bytes) => new TextDecoder().decode(bytes), (text) => encoder.encode(text));
const frame = (body: unknown) => codec.encode({
  headers: { ":message-type": { type: "string", value: "event" }, ":event-type": { type: "string", value: "chunk" } },
  body: encoder.encode(JSON.stringify(body)),
});
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "tether-bedrock-"));
  const store = new CredentialStore(join(dir, "credentials.json"));
  return { dir, store, clean: () => rmSync(dir, { recursive: true, force: true }) };
};
const post = (path: string, body: unknown) => new Request("http://tether" + path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("Bedrock credentials survive a restart and never enter status or a native launch's settings", async () => {
  const { store, clean } = setup();
  try {
    expect(accessAllows("drive", "setBedrock")).toBeFalse();
    store.setBedrock(settings);
    expect(store.snapshot("bedrock", sonnet.id)).toBeUndefined();
    store.set("bedrock", key);
    const current = new CredentialStore(store.file);
    const credential = current.snapshot("bedrock", sonnet.id)!;
    expect(credential.key).toBe(key);
    expect(JSON.stringify(current.status())).not.toContain(key);
    expect(current.status().bedrock).toMatchObject({ set: true, settings });
    expect(current.snapshot("bedrock", "unknown")).toBeUndefined();
    expect(() => current.setBedrock({ ...settings, region: "us-east-1.example.com" })).toThrow("region");
    expect(() => current.setBedrock({ ...settings, models: [sonnet, sonnet] })).toThrow("twice");
    const lease = claudeBedrockLease(credential);
    try {
      expect(lease.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
      expect(lease.env.AWS_BEARER_TOKEN_BEDROCK).not.toBe(key);
      expect((await fetch(lease.env.ANTHROPIC_BEDROCK_BASE_URL)).status).toBe(401);
      expect(confirmClaudeBilling({ apiProvider: "bedrock" }, credential).label).toBe("Amazon Bedrock");
      expect(() => confirmClaudeBilling({ apiProvider: "firstParty" }, credential)).toThrow("could not confirm");
    } finally { await lease.close(); }
    current.setBedrock({ ...settings, auth: "profile", profile: "work-sso" });
    expect(current.snapshot("bedrock", oss.id)).toMatchObject({ bedrock: { auth: "profile", profile: "work-sso" } });
    expect(current.snapshot("bedrock", oss.id)?.key).toBeUndefined();
    expect(current.snapshot("bedrock", sonnet.id)?.revision).not.toBe(credential.revision);
  } finally { clean(); }
});

test("native Claude and Codex streaming share a guard across independent gateway processes", async () => {
  const { store, clean } = setup();
  store.setBedrock({ ...settings, dailyLimitUsd: 0.005 });
  store.set("bedrock", key);
  const seen = [] as string[];
  const usage = { input_tokens: 1000, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 1000 } };
  const awsFrames = Buffer.concat([
    frame({ type: "message_start", message: { usage } }),
    frame({ type: "message_delta", usage: { output_tokens: 1000 } }),
    frame({ type: "message_stop" }),
  ]);
  const send = (async (input, request) => {
    const url = new URL(String(input));
    seen.push(url.hostname + url.pathname);
    expect(new Headers(request?.headers).get("authorization")).toBe(`Bearer ${key}`);
    const sse = { type: "response.completed", response: { usage: { input_tokens: 10_000, output_tokens: 1000 } } };
    return url.hostname.startsWith("bedrock-mantle.")
      ? new Response(`data: ${JSON.stringify(sse)}\n\n`, { headers: { "content-type": "text/event-stream" } })
      : new Response(new ReadableStream({
        start(controller) { controller.enqueue(awsFrames.subarray(0, 20)); controller.enqueue(awsFrames.subarray(20)); controller.close(); },
      }), { headers: { "content-type": "application/vnd.amazon.eventstream" } });
  }) as typeof fetch;
  const codexCosts: (number | undefined)[] = [], claudeCosts: (number | undefined)[] = [];
  const codex = bedrockGateway(store.snapshot("bedrock", oss.id)!, "codex", (_, cost) => codexCosts.push(cost.usd), send);
  const claude = bedrockGateway(store.snapshot("bedrock", sonnet.id)!, "claude", (_, cost) => claudeCosts.push(cost.usd), send);
  const invoke = `/model/${sonnet.id}/invoke-with-response-stream`;
  try {
    const config = providerConfig("bedrock", "http://127.0.0.1:5/v1");
    expect(config["model_providers.tether_bedrock.name"]).not.toBe("Amazon Bedrock");
    expect(config["model_providers.tether_bedrock.wire_api"]).toBe("responses");
    expect((await codex.handle(post("/responses", { model: sonnet.id }), "/responses")).status).toBe(400);
    const res = await codex.handle(post("/responses", { model: oss.id }), "/responses");
    expect(await res.text()).toContain("response.completed");
    expect(codexCosts).toEqual([undefined, 0.0021]);
    const stream = await claude.handle(post(invoke, {}), invoke);
    expect(Buffer.from(await stream.arrayBuffer())).toEqual(awsFrames);
    expect(claudeCosts).toEqual([undefined, 0.024]);
    const refused = await codex.handle(post("/responses", { model: oss.id }), "/responses");
    expect(refused.status).toBe(402);
    expect(await refused.text()).toContain("daily spend guard");
    expect(seen).toEqual([`bedrock-mantle.us-east-1.api.aws/v1/responses`, `bedrock-runtime.us-east-1.amazonaws.com${invoke}`]);
  } finally { codex.close(); claude.close(); clean(); }
});

test("AWS profile signs with the Bedrock Mantle service and never echoes AWS errors", async () => {
  const { dir, store, clean } = setup();
  const credentialsPath = join(dir, "aws-credentials");
  const previous = process.env.AWS_SHARED_CREDENTIALS_FILE;
  process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
  const accessKey = "AKIAFIXTUREBEDROCK12";
  writeFileSync(credentialsPath, `[fixture]\naws_access_key_id = ${accessKey}\naws_secret_access_key = fictional-secret-only-for-this-test\n`);
  store.setBedrock({ ...settings, auth: "profile", profile: "fixture" });
  const send = (async (_url, request) => {
    expect(new Headers(request?.headers).get("authorization")).toMatch(new RegExp(`Credential=${accessKey}/[0-9]{8}/us-east-1/bedrock-mantle/aws4_request`));
    return Response.json({ message: `denied for ${accessKey}` }, { status: 403 });
  }) as typeof fetch;
  const gateway = bedrockGateway(store.snapshot("bedrock", oss.id)!, "codex", undefined, send);
  try {
    const response = await gateway.handle(post("/responses", { model: oss.id }), "/responses");
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(accessKey);
  } finally {
    gateway.close();
    if (previous === undefined) delete process.env.AWS_SHARED_CREDENTIALS_FILE;
    else process.env.AWS_SHARED_CREDENTIALS_FILE = previous;
    clean();
  }
});

test("the spend guard persists missing usage and resets on the next UTC day", () => {
  const { store, clean } = setup();
  const day = Date.UTC(2026, 10, 22), first = new BedrockSpend(store.file);
  first.begin("unknown", 1, day);
  first.finish("unknown", unpricedBedrock());
  first.close();
  const next = new BedrockSpend(store.file);
  try {
    expect(next.begin("refused", 1, day + 1)).toBeFalse();
    expect(next.begin("new-day", 1, day + 24 * 60 * 60_000)).toBeTrue();
    next.finish("new-day", noBedrockCharge);
    expect(priceBedrock(settings, sonnet, { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 30 })).toMatchObject({ complete: false, reasons: ["no-cache-ttl"] });
  } finally { next.close(); clean(); }
});
