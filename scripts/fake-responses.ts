// A local stand-in for a Responses endpoint, HTTPS with a throwaway certificate, for e2e-move's
// sourceCarry: it logs what each request carried and answers with a fixed text. The runner beside it
// needs NODE_TLS_REJECT_UNAUTHORIZED=0. A request's `fake` field replaces fields of the final response
// (e2e-cost's fixtures); the default usage is the reference's, with the model it was asked for.
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
    const event = (o: { type: string }) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
    const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
    return new Response(event({ type: "response.created", response: { id } } as any) + event({ type: "response.output_item.done", output_index: 0, item } as any) + event({ type: "response.completed", response: { id, status: "completed", model: asked.model, output: [item], usage, ...asked.fake } } as any), { headers: { "content-type": "text/event-stream" } });
  },
});
console.log("listening", port);
