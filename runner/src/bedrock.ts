import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import { Sha256 } from "@aws-crypto/sha256-js";
import { EventStreamCodec } from "@smithy/core/event-streams";
import { SignatureV4 } from "@smithy/signature-v4";
import type { SessionCost } from "../../shared/costs";
import type { BedrockModel } from "../../shared/credentials";
import { BedrockSpend, bedrockRates, noBedrockCharge, priceBedrock, unpricedBedrock } from "./bedrockCost";
import { CredentialStore, type CredentialSnapshot } from "./credentials";
import { CostLedger } from "./costs";
import { meterStream, redactStream } from "./providerStreams";

type Report = (id: string, cost: SessionCost) => void;
type BedrockHarness = "claude" | "codex";
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const eventCodec = new EventStreamCodec((bytes) => decoder.decode(bytes), (text) => encoder.encode(text));
const GUARD = "Amazon Bedrock daily spend guard stopped this request. Check Settings, Bedrock.";
const errorBody = (harness: BedrockHarness, message: string, status: number) =>
  Response.json(harness === "claude" ? { message } : { error: { message, type: "api_error" } },
    { status, headers: status === 402 && harness === "claude" ? { "x-amzn-errortype": "ValidationException" } : undefined });

export const bedrockEndpoint = (region: string, harness: BedrockHarness) => harness === "codex"
  ? `https://bedrock-mantle.${region}.api.aws/v1`
  : `https://bedrock-runtime.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;

function parseJson(bytes: Uint8Array) { try { return JSON.parse(decoder.decode(bytes)); } catch { return undefined; } }

/** Native Bedrock Claude streams use AWS event framing with checksums, not SSE. */
export function meterClaudeBedrock(report: (usage: unknown) => void, key = "", partial: (usage: unknown) => void = () => {}): TransformStream<Uint8Array, Uint8Array> {
  let pending = Buffer.alloc(0);
  let usage: Record<string, unknown> = {};
  return new TransformStream({
    transform(chunk, controller) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 12) {
        const size = pending.readUInt32BE(0);
        if (size < 16 || size > 32 * 1024 * 1024) throw new Error("Invalid Bedrock event frame.");
        if (pending.length < size) break;
        const frame = pending.subarray(0, size);
        pending = pending.subarray(size);
        const event = eventCodec.decode(frame);
        let out: Uint8Array = frame;
        const payload = parseJson(event.body);
        const type = event.headers[":message-type"];
        if (type?.value === "exception" || type?.value === "error") {
          out = eventCodec.encode({ headers: event.headers, body: encoder.encode('{"message":"Amazon Bedrock streaming request failed."}') });
        } else {
          const wrapped = typeof payload?.bytes === "string";
          const text = wrapped ? Buffer.from(payload.bytes, "base64").toString("utf8") : decoder.decode(event.body);
          const message = wrapped ? parseJson(encoder.encode(text)) : payload;
          if (message?.type === "message_start") usage = { ...message.message?.usage };
          if (message?.type === "message_delta") usage = { ...usage, ...message.usage };
          if (message?.type === "message_start" || message?.type === "message_delta") partial(usage);
          if (message?.type === "message_stop") report(usage);
          if (key && text.includes(key)) {
            const safe = text.replaceAll(key, "[redacted]");
            const body = wrapped ? JSON.stringify({ ...payload, bytes: Buffer.from(safe).toString("base64") }) : safe;
            out = eventCodec.encode({ headers: event.headers, body: encoder.encode(body) });
          }
        }
        controller.enqueue(out);
      }
    },
    flush() { if (pending.length) throw new Error("Incomplete Bedrock event frame."); },
  });
}

export function isGatewayBearer(request: Request, token: string) {
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function bedrockGateway(credential: CredentialSnapshot, harness: BedrockHarness, report: Report = () => {}, send: typeof fetch = fetch) {
  const { bedrock: bedrockSettings, key, file } = credential;
  if (!bedrockSettings || !file || (!key && !bedrockSettings.profile)) throw new Error("Configure Amazon Bedrock in Settings, Bedrock.");
  const settings = bedrockSettings;
  const signer = !key && settings.profile ? new SignatureV4({
    credentials: fromIni({ profile: settings.profile }),
    region: settings.region,
    service: harness === "claude" ? "bedrock" : "bedrock-mantle",
    sha256: Sha256,
  }) : undefined;
  const spend = new BedrockSpend(file);

  async function handle(req: Request, path: string): Promise<Response> {
    const operation = harness === "claude" ? path.match(/^\/model\/([^/]+)\/(invoke|invoke-with-response-stream|count-tokens)$/) : undefined;
    const inference = req.method === "POST" && (harness === "codex" ? path === "/responses" : !!operation && operation[2] !== "count-tokens");
    const profiles = harness === "claude" && req.method === "GET" && /^\/inference-profiles(?:\/[^/]+)?$/.test(path);
    const models = harness === "codex" && req.method === "GET" && path === "/models";
    const count = harness === "claude" && req.method === "POST" && operation?.[2] === "count-tokens";
    if (!inference && !models && !count && !profiles) return errorBody(harness, "Amazon Bedrock does not support this provider operation.", 404);
    const requestId = randomUUID();
    let started = false;
    let finished = false;
    const settle = (cost: SessionCost, ledger = cost) => {
      if (!started || finished) return;
      spend.finish(requestId, ledger);
      finished = true;
      report(requestId, cost);
    };
    // A Stop, a dropped connection or a mid-stream error leaves no final usage. The session shows partial
    // coverage, but the guard counts only the usage seen so far, so routine interruptions don't lock it for the day.
    let seen: Record<string, unknown> | undefined;
    const interrupted = () => {
      const partial = seen && model ? priceBedrock(settings, model, { output_tokens: 0, ...seen }, tier).usd : undefined;
      settle(unpricedBedrock(), { usd: partial ?? 0, estimated: true, complete: true });
    };
    let model: BedrockModel | undefined;
    let tier: string | undefined;
    try {
      const body = req.method === "POST" ? new Uint8Array(await req.arrayBuffer()) : undefined;
      const input = body && parseJson(body);
      const id = operation ? decodeURIComponent(operation[1]!) : input?.model;
      if (models) return Response.json({ object: "list", data: settings.models.filter((row) => row.harness === harness).map((row) => ({ id: row.id, object: "model" })) });
      model = settings.models.find((row) => row.harness === harness && row.id === id);
      if (!model && !profiles) return errorBody(harness, "Select a configured model in Settings, Bedrock.", 400);
      tier = harness === "claude" ? req.headers.get("x-amzn-bedrock-service-tier") ?? undefined : input?.service_tier;
      const endpoint = bedrockEndpoint(settings.region, harness);
      const target = new URL((profiles ? endpoint.replace("bedrock-runtime.", "bedrock.") : endpoint) + path);
      // The Claude harness can list and resolve configured inference profiles through the AWS control plane.
      const query = Object.fromEntries(new URL(req.url).searchParams);
      if (profiles) target.search = new URLSearchParams(query).toString();
      const headers = new Headers();
      for (const name of ["content-type", "accept", "x-amzn-bedrock-accept", "x-amzn-bedrock-service-tier", "x-amzn-bedrock-guardrailidentifier", "x-amzn-bedrock-guardrailversion"]) {
        const value = req.headers.get(name);
        if (value) headers.set(name, value);
      }
      if (key) headers.set("authorization", `Bearer ${key}`);
      const outgoing = signer ? (await signer.sign({
        hostname: target.hostname, protocol: target.protocol, method: req.method, path: target.pathname, ...(profiles ? { query } : {}),
        headers: { ...Object.fromEntries(headers), host: target.host }, body,
      })).headers : headers;
      if (inference) {
        const limit = new CredentialStore(file).bedrock()?.dailyLimitUsd;
        if (limit !== undefined && (!bedrockRates(settings, model!) || (tier && !["default", "auto", "standard"].includes(tier)))) {
          return errorBody(harness, "Configure rates for this Bedrock model and service tier before using the daily spend guard.", 402);
        }
        if (!spend.begin(requestId, limit)) return errorBody(harness, GUARD, 402);
        started = true;
        report(requestId, unpricedBedrock());
      }
      const upstream = await send(target, { method: req.method, headers: outgoing, body: body as Uint8Array<ArrayBuffer> | undefined, redirect: "error", signal: req.signal });
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        // Bedrock does not bill a request that returns an error status, including throttling and 5xx.
        settle(noBedrockCharge);
        const message = upstream.status === 401 || upstream.status === 403 ? "Amazon Bedrock rejected the credential or model access. Check Settings, Bedrock."
          : `Amazon Bedrock request failed (HTTP ${upstream.status}).`;
        return errorBody(harness, message, upstream.status);
      }
      const contentType = upstream.headers.get("content-type") ?? "application/json";
      const out = { "content-type": contentType };
      if (!upstream.body) {
        settle(unpricedBedrock());
        return new Response(null, { status: upstream.status, headers: out });
      }
      const price = (usage: unknown, reportedTier?: string, output?: unknown) => {
        if (!model) return;
        const cost = priceBedrock(settings, model, usage, reportedTier ?? tier);
        const hostedTools = Array.isArray(output) && output.some((item) => ["web_search_call", "file_search_call", "image_generation_call", "code_interpreter_call"].includes(item?.type));
        settle(hostedTools ? { ...cost, complete: false, reasons: [...(cost.reasons ?? []), "tool-fee"] } : cost);
      };
      let stream: ReadableStream<Uint8Array> = upstream.body;
      if (contentType.includes("application/vnd.amazon.eventstream")) stream = stream.pipeThrough(meterClaudeBedrock(price, key, (usage) => { seen = usage as Record<string, unknown>; }));
      else if (contentType.includes("text/event-stream")) {
        if (key) stream = stream.pipeThrough(redactStream(key));
        stream = stream.pipeThrough(meterStream((response) => price(response?.usage, response?.service_tier, response?.output), interrupted));
      } else {
        const text = await upstream.text();
        const json = parseJson(encoder.encode(text));
        price(json?.usage, json?.service_tier, json?.output);
        return new Response(key ? text.replaceAll(key, "[redacted]") : text, { status: upstream.status, headers: out });
      }
      const reader = stream.getReader();
      return new Response(new ReadableStream({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              interrupted();
              controller.close();
            } else controller.enqueue(next.value);
          } catch (error) { interrupted(); controller.error(error); }
        },
        async cancel() { interrupted(); await reader.cancel(); },
      }), { status: upstream.status, headers: out });
    } catch {
      interrupted();
      return errorBody(harness, "Amazon Bedrock could not be reached. Check the runner's AWS credentials and region.", 502);
    }
  }
  return { handle, close: () => spend.close() };
}

export function claudeBedrockLease(credential: CredentialSnapshot, onCost?: (cost: SessionCost & { id: string }) => void) {
  const id = `bedrock-${randomUUID()}`;
  const ledger = new CostLedger();
  ledger.begin(id, true);
  const gateway = bedrockGateway(credential, "claude", (request, cost) => {
    onCost?.({ id, ...ledger.report(id, request, cost) });
  });
  const token = `tether-bedrock-${randomBytes(32).toString("hex")}`;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    fetch: (request) => isGatewayBearer(request, token)
      ? gateway.handle(request, new URL(request.url).pathname) : new Response("Unauthorized", { status: 401 }),
  });
  let closing: Promise<void> | undefined;
  return {
    helper: "",
    env: {
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      CLAUDE_CODE_USE_BEDROCK: "1",
      DISABLE_TELEMETRY: "1",
      AWS_REGION: credential.bedrock!.region,
      AWS_BEARER_TOKEN_BEDROCK: token,
      ...(credential.deployment ? {
        ANTHROPIC_DEFAULT_OPUS_MODEL: credential.deployment,
        ANTHROPIC_DEFAULT_SONNET_MODEL: credential.deployment,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: credential.deployment,
      } : {}),
      ANTHROPIC_BEDROCK_BASE_URL: `http://127.0.0.1:${server.port}`,
    },
    cost: () => ledger.get(id),
    close() { return closing ??= server.stop(true).finally(() => gateway.close()); },
  };
}
