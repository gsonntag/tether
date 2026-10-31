import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { redactStream } from "./privateHost";

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
