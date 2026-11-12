// A private process, outside the runner lifetime: sanitize the provider boundary before any
// upstream error or stream can reach Codex's rollout, logs or tool environment.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AzurePricing } from "../../../../shared/azureRates";
import { CostLedger, priceResponse } from "../../costs";
import { spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BEARER_FILE, privateEnvironment, providerConfig, sourceProvider, type ApiSource } from "./sources";
import { upstreamFailure, upstreamHeaders, upstreamUrl } from "./upstream";
import { safeRetryAt } from "../../rateLimit";

const SAFE_ERROR_CODES = new Map<string, string>([
  ...["rate_limit_error", "rate_limit_exceeded", "rateLimitExceeded", "responseTooManyFailedAttempts", "insufficient_quota", "quota_exceeded", "billing_hard_limit_reached", "usage_limit_exceeded", "unauthorized", "authentication_error", "invalid_api_key"].map((x): [string, string] => [x.toLowerCase(), x]),
]);

/** Read at most max bytes from an untrusted provider error, then cancel the rest. */
export async function readErrorPrefix(body: ReadableStream<Uint8Array> | null, max = 16 * 1024, signal?: AbortSignal, timeoutMs = 1_500): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; reject(new Error("Provider error body timed out")); }, timeoutMs);
    timer.unref?.();
  });
  const aborted = signal && new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason ?? new Error("Request aborted"));
    else {
      onAbort = () => reject(signal.reason ?? new Error("Request aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    while (size < max) {
      const { value, done } = await Promise.race([reader.read(), timeout, ...(aborted ? [aborted] : [])]);
      if (done || !value) break;
      const take = value.subarray(0, max - size);
      chunks.push(take); size += take.length;
      if (take.length !== value.length || size >= max) break;
    }
  } catch (error) {
    if (!timedOut) throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export function safeProviderErrorCode(body: any): string | undefined {
  const candidates = [body?.error?.code, body?.error?.type, body?.code, body?.type];
  for (const value of candidates) if (typeof value === "string") {
    const safe = SAFE_ERROR_CODES.get(value.toLowerCase());
    if (safe) return safe;
  }
  // Recognize common quota/billing messages inside the bounded provider body, but return only a
  // canonical code. Provider text (which may echo credentials) never reaches the daemon.
  const message = typeof body?.error?.message === "string" ? body.error.message : typeof body?.message === "string" ? body.message : "";
  if (/\b(?:insufficient|exceeded|out of|over)\s+(?:(?:the|your)\s+)?(?:current\s+)?quota\b|\bquota\s+(?:exceeded|limit|reached)\b|\bbilling\s+(?:hard\s+)?limit\b/i.test(message)) return "insufficient_quota";
  return undefined;
}

export function retryAtFromHeaders(headers: Headers, now = Date.now()): number | undefined {
  const normal = safeRetryAt(headers.get("retry-after"), now);
  if (normal) return normal;
  const ms = headers.get("retry-after-ms");
  if (!ms || !/^\d+(?:\.\d+)?$/.test(ms.trim())) return undefined;
  const at = now + Number(ms.trim());
  return Number.isFinite(at) && at > now ? at : undefined;
}

/** A streaming redactor holds a possible partial key across network chunk boundaries. */
export function redactStream(key: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const clean = (text: string) => key ? text.replaceAll(key, "[redacted]") : text;
  const prefixLength = (text: string) => {
    for (let n = Math.min(key.length - 1, text.length); n > 0; n--) if (text.endsWith(key.slice(0, n))) return n;
    return 0;
  };
  return new TransformStream({
    transform(chunk, controller) {
      pending = clean(pending + decoder.decode(chunk, { stream: true }));
      const safe = pending.length - prefixLength(pending);
      if (safe) { controller.enqueue(encoder.encode(pending.slice(0, safe))); pending = pending.slice(safe); }
    },
    flush(controller) {
      const final = clean(pending + decoder.decode());
      // A truncated upstream error may finish with almost an entire credential. Never flush an
      // ambiguous key prefix into the native harness's permanent logs or rollout.
      controller.enqueue(encoder.encode(final.slice(0, final.length - prefixLength(final))));
    },
  });
}

/** Reads complete SSE records while forwarding the same bytes without buffering the response. */
export function meterStream(report: (response: any) => void, incomplete: () => void): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";
  let completed = false;
  const consume = () => {
    pending = pending.replace(/\r\n/g, "\n");
    let boundary: number;
    while ((boundary = pending.indexOf("\n\n")) >= 0) {
      const event = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
      const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") continue;
      let json: any;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.type === "response.completed" || json.type === "response.failed" || json.type === "response.incomplete") { completed = true; report(json.response); }
    }
    if (pending.length > 32 * 1024 * 1024) { pending = ""; incomplete(); }
  };
  return new TransformStream({
    transform(chunk, controller) { pending += decoder.decode(chunk, { stream: true }); consume(); controller.enqueue(chunk); },
    flush() { pending += decoder.decode(); consume(); if (!completed) incomplete(); },
  });
}

/** A deployment's pricing applies only to requests naming that deployment. */
export function deploymentPricing(pricing: AzurePricing | undefined, deployment: string | undefined, request?: string): AzurePricing | undefined {
  if (!pricing || !deployment) return pricing;
  try { return JSON.parse(request ?? "").model === deployment ? pricing : undefined; } catch { return undefined; }
}

export async function servePrivateHost(args = process.argv.slice(2)) {
  const [home, projectPath, sourceArg, endpoint, id, bin] = args;
  if (!home || !projectPath || !endpoint || !id || !bin || (sourceArg !== "openai" && sourceArg !== "azure")) throw new Error("Invalid private Codex launch.");
  const source: ApiSource = sourceArg;
  const key = process.env.TETHER_GATEWAY_KEY;
  if (!key) throw new Error("No configured API key for private Codex.");
  let pricing: AzurePricing | undefined;
  try { pricing = JSON.parse(process.env.TETHER_GATEWAY_PRICING ?? "null") ?? undefined; } catch {}
  // Azure: the deployment the pricing is for. A request naming another isn't priced with it.
  const deployment = process.env.TETHER_GATEWAY_DEPLOYMENT || undefined;
  const ledger = new CostLedger(join(home, "costs.json"));
  ledger.begin(id, true);
  // A local capability; never the upstream credential. Random, never derived from the session id:
  // the id is on this process's command line, which every local user can read, and the proxy
  // listens on a loopback port every local user can reach. The TUI reads it from the private home.
  const bearer = `tether-private-${randomBytes(32).toString("hex")}`;
  writeFileSync(join(home, BEARER_FILE), bearer, { mode: 0o600 });
  chmodSync(join(home, BEARER_FILE), 0o600);
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const given = Buffer.from(req.headers.get("authorization") ?? ""), want = Buffer.from(`Bearer ${bearer}`);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return new Response("Unauthorized", { status: 401 });
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/v1/")) return new Response("Not found", { status: 404 });
      const headers = upstreamHeaders(source, key, req.headers);
      const inference = req.method === "POST" && url.pathname.endsWith("/responses");
      const requestId = `request-${randomUUID()}`;
      const unknown = () => { if (inference) ledger.report(id, requestId, { estimated: true, complete: false, reasons: ["no-usage"] }); };
      try {
        // Persist an incomplete request before forwarding. A host crash or failed cost write
        // can leave a partial total, never a falsely complete one.
        if (inference) unknown();
        // Whole, for pricing: bytes, because only the upstream has to understand them.
        const sent = inference ? await req.arrayBuffer() : undefined;
        const target = upstreamUrl(endpoint, url.pathname.slice(3) + url.search);
        const upstream = await fetch(target, { method: req.method, headers, body: sent ?? req.body, redirect: "error", signal: req.signal });
        if (!upstream.ok) {
          // Providers sometimes repeat a partly masked key in auth errors. Do not forward any
          // provider error body or headers into native logs, even when the full key is absent.
          if (inference && (upstream.status === 401 || upstream.status === 403)) ledger.report(id, requestId, { usd: 0, estimated: false, complete: true });
          let providerError: any;
          if (upstream.status === 429) {
            const prefix = await readErrorPrefix(upstream.body, 16 * 1024, req.signal);
            try { providerError = JSON.parse(prefix); } catch {}
          } else await upstream.body?.cancel().catch(() => {});
          const message = upstreamFailure(source, upstream.status);
          const code = upstream.status === 429 ? safeProviderErrorCode(providerError) : undefined;
          const retryAt = upstream.status === 429 ? retryAtFromHeaders(upstream.headers) : undefined;
          const headers = new Headers();
          if (retryAt) {
            const ms = Math.max(1, retryAt - Date.now());
            headers.set("retry-after", String(Math.max(1, Math.ceil(ms / 1000))));
            headers.set("retry-after-ms", String(ms));
          }
          const fatal = code && ["insufficient_quota", "quota_exceeded", "billing_hard_limit_reached", "usage_limit_exceeded", "unauthorized", "authentication_error", "invalid_api_key"].includes(code.toLowerCase());
          return Response.json({ error: { message, type: upstream.status === 429 && !fatal ? "rate_limit_error" : "api_error", ...(code ? { code } : {}), ...(retryAt ? { retry_at: retryAt } : {}) } }, { status: upstream.status, headers });
        }
        const out = new Headers(upstream.headers);
        for (const h of ["content-length", "content-encoding", "transfer-encoding", "connection"]) out.delete(h);
        for (const [h,v] of out) if (h.includes(key)) out.delete(h); else out.set(h, v.replaceAll(key, "[redacted]"));
        let body = upstream.body?.pipeThrough(redactStream(key));
        if (inference && upstream.ok && body) body = body.pipeThrough(meterStream((response) => {
          const request = sent && new TextDecoder().decode(sent);
          const cost = priceResponse(source, response, { pricing: deploymentPricing(pricing, deployment, request), request });
          ledger.report(id, typeof response?.id === "string" ? response.id : requestId, cost);
          if (typeof response?.id === "string") ledger.report(id, requestId, { usd: 0, estimated: false, complete: true });
        }, unknown));
        return new Response(body, { status: upstream.status, headers: out });
      } catch { unknown(); return Response.json({ error: { message: "The configured API source could not be reached.", type: "connection_error" } }, { status: 502 }); }
    },
  });
  const proxyBase = `http://127.0.0.1:${server.port}/v1`;
  const provider = sourceProvider(source);
  const config = providerConfig(source, proxyBase);
  // OpenAI's upstream is fixed; the host, not this config, owns the actual remote endpoint.
  config[`model_providers.${provider}.base_url`] = proxyBase;
  const lines = [
    `model_provider=${JSON.stringify(provider)}`, 'model="gpt-6-luna"', 'model_reasoning_effort="low"', 'check_for_update_on_startup=false',
    '[history]', 'persistence="none"', '[features]', 'shell_snapshot=false',
    '[shell_environment_policy]', 'inherit="core"', 'exclude=["TETHER_*","OPENAI_*","AZURE_*","CODEX_*","ANTHROPIC_*"]',
    `[model_providers.${provider}]`,
    ...Object.entries(config).filter(([k]) => k.startsWith(`model_providers.${provider}.`)).map(([k,v]) => `${k.split(".").at(-1)}=${typeof v === "string" ? JSON.stringify(v) : String(v)}`),
  ];
  writeFileSync(join(home, "config.toml"), lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(join(home, "config.toml"), 0o600);
  writeFileSync(join(home, "source.json"), JSON.stringify({ endpoint, proxyBase, ...(pricing ? { pricing } : {}) }), { mode: 0o600 });
  const env = privateEnvironment(home, bearer);
  delete env.TETHER_GATEWAY_KEY;
  delete env.TETHER_GATEWAY_PRICING;
  delete env.TETHER_GATEWAY_DEPLOYMENT;
  const codex = spawn(bin, ["app-server", "--listen", `unix://${join(home, "s")}`], { env, stdio: "ignore", cwd: projectPath });
  let ending = false;
  const end = () => { if (ending) return; ending = true; codex.kill("SIGTERM"); server.stop(true); };
  process.on("SIGTERM", end); process.on("SIGINT", end);
  codex.on("error", () => { end(); process.exitCode = 1; });
  codex.on("exit", (code) => { end(); process.exitCode = code ?? 1; });
}
if (import.meta.main) await servePrivateHost();
