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
