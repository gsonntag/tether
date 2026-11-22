import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PROXY_SERVE, readErrorPrefix, redactStream, retryAtFromHeaders, safeProviderErrorCode } from "./privateHost";

test("upstream credential echoes are removed before the native transcript, including keys split across chunks", async () => {
  const key = randomUUID();
  const wire = new TextEncoder().encode(`data: {"error":"hé ${key} ${key}"}\n\n`);
  for (const width of [1, 7, key.length - 1, key.length + 4, 1000]) {
    const body = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < wire.length; i += width) c.enqueue(wire.slice(i, i + width)); c.close(); } });
    const text = await new Response(body.pipeThrough(redactStream(key))).text();
    expect(text).toBe('data: {"error":"hé [redacted] [redacted]"}\n\n');
    expect(text).not.toContain(key);
  }
});

test("an upstream stream cut off inside a credential never flushes its held prefix", async () => {
  const key = `fake-${randomUUID()}`;
  const body = new Response(`error: ${key.slice(0, -1)}`).body!;
  expect(await new Response(body.pipeThrough(redactStream(key))).text()).toBe("error: ");
});

test("gateway error parsing is bounded and keeps only allowlisted provider codes", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(c) { c.enqueue(new TextEncoder().encode("x".repeat(32))); },
    cancel() { canceled = true; },
  });
  expect(await readErrorPrefix(body, 64)).toHaveLength(64);
  expect(canceled).toBe(true);
  expect(safeProviderErrorCode({ error: { code: "insufficient_quota", message: "private body" } })).toBe("insufficient_quota");
  expect(safeProviderErrorCode({ error: { message: "You have exceeded your current quota. private secret detail" } })).toBe("insufficient_quota");
  expect(safeProviderErrorCode({ error: { code: "my-secret-provider-code", message: "private body" } })).toBeUndefined();
});

test("gateway retry timing accepts both sanitized retry headers", () => {
  expect(retryAtFromHeaders(new Headers({ "retry-after-ms": "2500" }), 1000)).toBe(3500);
  expect(retryAtFromHeaders(new Headers({ "retry-after": "3" }), 1000)).toBe(4000);
  expect(retryAtFromHeaders(new Headers({ "retry-after": "bad", "retry-after-ms": "bad" }), 1000)).toBeUndefined();
});

test("a stalled upstream error body is canceled after the bounded read timeout", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() { return new Promise<void>(() => {}); },
    cancel() { canceled = true; },
  });
  const started = Date.now();
  expect(await readErrorPrefix(body, 1024, undefined, 25)).toBe("");
  expect(Date.now() - started).toBeLessThan(500);
  expect(canceled).toBe(true);
});

test("the proxy keeps a streamed response open across a provider silence longer than Bun's default idle timeout", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch() {
    let n = 0;
    return new Response(new ReadableStream({ async pull(c) {
      if (n++ === 2) return c.close();
      c.enqueue(new TextEncoder().encode(`data: ${n}\n\n`));
      if (n === 1) await Bun.sleep(15_000);
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const proxy = Bun.serve({ ...PROXY_SERVE, async fetch(req) {
    const up = await fetch(`http://127.0.0.1:${upstream.port}/`, { signal: req.signal, timeout: false });
    return new Response(up.body, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    expect(await (await fetch(`http://127.0.0.1:${proxy.port}/`)).text()).toBe("data: 1\n\ndata: 2\n\n");
  } finally { proxy.stop(true); upstream.stop(true); }
}, 30_000);
