// A local stand-in for a Responses endpoint, HTTPS with a throwaway certificate, for e2e-move's
// sourceCarry: it logs what each request carried and answers with a fixed text. The runner beside it
// needs NODE_TLS_REJECT_UNAUTHORIZED=0. A request's `fake` field replaces fields of the final response
// (e2e-cost's fixtures); the default usage is the reference's, with the model it was asked for. A model
// starting "missing-" is a deployment Azure doesn't have: 404 DeploymentNotFound. A model (Azure: a
// deployment name) with "-in<n>", "-ca<n>", "-wr<n>", "-out<n>" or "-tier<name>" in it reports those input,
// cached, cache-write and output tokens and that service tier (e2e-keys' Azure prices).
//   bun scripts/fake-responses.ts <log file> <port> <cert.pem> <key.pem>
import { appendFileSync, readFileSync } from "node:fs";

const [log, port, cert, key] = process.argv.slice(2);
let n = 0;
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(port),
  tls: { cert: readFileSync(cert!, "utf8"), key: readFileSync(key!, "utf8") },
  async fetch(req) {
    const url = new URL(req.url);
    const body = await req.text();
    appendFileSync(log!, `${JSON.stringify({ path: url.pathname, body })}\n`);
    if (!url.pathname.endsWith("/responses")) return Response.json({ data: [], models: [] });
    const id = `resp_${++n}`;
    const item = { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: `Fake reply ${n}.`, annotations: [] }] };
    let asked: any = {};
    try { asked = JSON.parse(body); } catch {}
    // An Azure deployment that isn't there (e2e-keys' Test).
    if (typeof asked.model === "string" && asked.model.startsWith("missing-")) return Response.json({ error: { code: "DeploymentNotFound", message: "The API deployment for this resource does not exist." } }, { status: 404 });
    const event = (o: { type: string }) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
    const name = typeof asked.model === "string" ? asked.model : "";
    const part = (tag: string) => { const m = name.match(new RegExp(`(?:^|-)${tag}(\\d+)(?=-|$)`)); return m ? Number(m[1]) : undefined; };
    const tokens = { input: part("in") ?? 10, cached: part("ca") ?? 0, writes: part("wr") ?? 0, output: part("out") ?? 2 };
    const tier = name.match(/(?:^|-)tier([a-z]+)(?=-|$)/)?.[1];
    const usage = { input_tokens: tokens.input, output_tokens: tokens.output, total_tokens: tokens.input + tokens.output, input_tokens_details: { cached_tokens: tokens.cached, cache_write_tokens: tokens.writes }, output_tokens_details: { reasoning_tokens: 0 } };
    if (tier) asked.fake = { service_tier: tier, ...asked.fake };
    // Not streamed (Settings' Test): the final response as JSON.
    if (asked.stream === false) return Response.json({ id, status: "completed", model: asked.model, output: [item], usage, ...asked.fake });
    return new Response(event({ type: "response.created", response: { id } } as any) + event({ type: "response.output_item.done", output_index: 0, item } as any) + event({ type: "response.completed", response: { id, status: "completed", model: asked.model, output: [item], usage, ...asked.fake } } as any), { headers: { "content-type": "text/event-stream" } });
  },
});
console.log("listening", port);
