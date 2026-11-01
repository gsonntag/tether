// A private process, outside the runner lifetime: sanitize the provider boundary before any
// upstream error or stream can reach Codex's rollout, logs or tool environment.
import { randomUUID } from "node:crypto";
import type { AzurePricing } from "../../../../shared/azureRates";
import { CostLedger, priceResponse } from "../../costs";
import { spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { privateEnvironment, providerConfig, sourceProvider, type ApiSource } from "./sources";
import { upstreamFailure, upstreamHeaders, upstreamUrl } from "./upstream";

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
  const bearer = `tether-private-${id}`; // A local capability; never the upstream credential.
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${bearer}`) return new Response("Unauthorized", { status: 401 });
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
          await upstream.body?.cancel().catch(() => {});
          const message = upstreamFailure(source, upstream.status);
          return Response.json({ error: { message, type: upstream.status === 429 ? "rate_limit_error" : "api_error" } }, { status: upstream.status });
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
