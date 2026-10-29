import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, FrameReader, UnixWebSocket } from "./ws";

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((f) => f()));

test("frames round-trip at every length encoding, split anywhere, masked or not", () => {
  for (const n of [0, 5, 125, 126, 1000, 65535, 65536, 200_000]) {
    const payload = new Uint8Array(n).map((_, i) => i % 251);
    const frame = encodeFrame(0x1, payload);
    const r = new FrameReader();
    // Fed in uneven chunks, as a socket delivers them.
    const got = [] as ReturnType<FrameReader["push"]>;
    for (let i = 0; i < frame.length; i += 7777) got.push(...r.push(frame.slice(i, i + 7777)));
    expect(got.length).toBe(1);
    expect(got[0]!.opcode).toBe(1);
    expect(got[0]!.fin).toBe(true);
    expect(Buffer.from(got[0]!.payload).equals(Buffer.from(payload))).toBe(true);
  }
  // A server's unmasked frame, two in one chunk.
  const plain = (s: string) => new Uint8Array([0x81, s.length, ...new TextEncoder().encode(s)]);
  const r = new FrameReader();
  const both = new Uint8Array([...plain("ab"), ...plain("cde")]);
  expect(r.push(both).map((f) => new TextDecoder().decode(f.payload))).toEqual(["ab", "cde"]);
});

test("a real WebSocket over a Unix socket: handshake, both ways, big messages, close", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "tether-ws-")), "s.sock");
  const seen: string[] = [];
  const server = Bun.serve({
    unix: path,
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      message(ws, m) {
        seen.push(String(m));
        ws.send(`echo:${m}`);
        if (m === "bye") ws.close();
      },
    },
  });
  stops.push(() => server.stop(true));
  const got: string[] = [];
  let closed = "";
  const ws = await UnixWebSocket.connect(path, { message: (t) => got.push(t), close: (r) => (closed = r) });
  ws.send("hello");
  const big = "x".repeat(300_000);
  ws.send(big);
  for (let i = 0; i < 100 && got.length < 2; i++) await Bun.sleep(10);
  expect(got[0]).toBe("echo:hello");
  expect(got[1]!.length).toBe(big.length + 5);
  expect(seen[1]!.length).toBe(big.length);
  ws.send("bye");
  for (let i = 0; i < 100 && !closed; i++) await Bun.sleep(10);
  expect(closed).toBeTruthy();
  expect(ws.isOpen).toBe(false);
  expect(() => ws.send("after")).toThrow("closed");
});

test("connecting where nothing listens fails with ENOENT", async () => {
  const err: any = await UnixWebSocket.connect("/tmp/tether-nothing-here.sock", { message() {}, close() {} }).catch((e) => e);
  expect(err?.code).toBe("ENOENT");
});
