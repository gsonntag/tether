// A minimal WebSocket client over a Unix socket (RFC 6455), for Codex's app-server daemon (SPEC §6):
// its control socket takes an HTTP upgrade, then JSON-RPC text frames. Bun's WebSocket can't dial
// a Unix socket, and `codex app-server proxy` only relays raw bytes, so Tether speaks WS itself.
//
// Client frames are masked; server frames aren't. Text and continuation frames are reassembled,
// pings are answered, a close frame ends the connection.

import { randomBytes, createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface WsHandlers {
  message(text: string): void;
  close(reason: string): void;
}

/** Encodes one masked client frame. */
export function encodeFrame(opcode: number, payload: Uint8Array, mask: Uint8Array = randomBytes(4)): Uint8Array {
  const n = payload.length;
  const head = n < 126 ? 2 : n < 65536 ? 4 : 10;
  const out = new Uint8Array(head + 4 + n);
  out[0] = 0x80 | opcode;
  if (n < 126) out[1] = 0x80 | n;
  else if (n < 65536) {
    out[1] = 0x80 | 126;
    out[2] = n >> 8;
    out[3] = n & 0xff;
  } else {
    out[1] = 0x80 | 127;
    const dv = new DataView(out.buffer);
    dv.setUint32(2, Math.floor(n / 2 ** 32));
    dv.setUint32(6, n >>> 0);
  }
  out.set(mask, head);
  for (let i = 0; i < n; i++) out[head + 4 + i] = payload[i]! ^ mask[i & 3]!;
  return out;
}

export interface Frame {
  fin: boolean;
  opcode: number;
  payload: Uint8Array;
}

/**
 * Reads whole frames off a byte stream; keeps what's left for the next chunk. The bytes sit in one
 * growable buffer read from an offset, so a big frame arriving in many chunks is copied about once,
 * not once per chunk.
 */
export class FrameReader {
  private buf = new Uint8Array(64 * 1024);
  private start = 0;
  private end = 0;

  private append(chunk: Uint8Array) {
    if (this.end + chunk.length > this.buf.length) {
      const unread = this.end - this.start;
      const need = unread + chunk.length;
      // Room after moving the unread bytes to the front, else a bigger buffer.
      const next = need <= this.buf.length / 2 ? this.buf : new Uint8Array(Math.max(need * 2, this.buf.length));
      if (next === this.buf) next.copyWithin(0, this.start, this.end);
      else next.set(this.buf.subarray(this.start, this.end), 0);
      this.buf = next;
      this.start = 0;
      this.end = unread;
    }
    this.buf.set(chunk, this.end);
    this.end += chunk.length;
  }

  push(chunk: Uint8Array): Frame[] {
    this.append(chunk);
    const out: Frame[] = [];
    for (;;) {
      const b = this.buf;
      const at = this.start;
      const have = this.end - at;
      if (have < 2) break;
      const masked = (b[at + 1]! & 0x80) !== 0;
      let len = b[at + 1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (have < 4) break;
        len = (b[at + 2]! << 8) | b[at + 3]!;
        off = 4;
      } else if (len === 127) {
        if (have < 10) break;
        const dv = new DataView(b.buffer, b.byteOffset + at);
        len = dv.getUint32(2) * 2 ** 32 + dv.getUint32(6);
        off = 10;
      }
      const maskAt = at + off;
      if (masked) off += 4;
      if (have < off + len) break;
      let payload = b.slice(at + off, at + off + len);
      if (masked) payload = payload.map((x, i) => x ^ b[maskAt + (i & 3)]!);
      out.push({ fin: (b[at]! & 0x80) !== 0, opcode: b[at]! & 0x0f, payload });
      this.start = at + off + len;
    }
    if (this.start === this.end) this.start = this.end = 0;
    return out;
  }
}

/** One WebSocket connection to a Unix socket. */
export class UnixWebSocket {
  private socket?: Awaited<ReturnType<typeof Bun.connect>>;
  private reader = new FrameReader();
  private parts: Uint8Array[] = [];
  private closed = false;
  private pending: Uint8Array[] = [];
  private dec = new TextDecoder();
  private enc = new TextEncoder();

  private constructor(private h: WsHandlers) {}

  /** Connects and upgrades; rejects when the socket isn't there or the upgrade is refused. */
  static connect(path: string, h: WsHandlers, timeoutMs = 10_000): Promise<UnixWebSocket> {
    const ws = new UnixWebSocket(h);
    return ws.open(path, timeoutMs).then(() => ws);
  }

  private open(path: string, timeoutMs: number): Promise<void> {
    const key = randomBytes(16).toString("base64");
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    let head = "";
    let upgraded = false;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("The Codex daemon didn't answer."));
        this.socket?.end();
      }, timeoutMs);
      const fail = (e: Error) => {
        clearTimeout(timer);
        reject(e);
      };
      Bun.connect({
        unix: path,
        socket: {
          open: (s) => {
            this.socket = s;
            s.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
          },
          data: (_s, chunk: Uint8Array) => {
            if (!upgraded) {
              head += Buffer.from(chunk).toString("latin1");
              const end = head.indexOf("\r\n\r\n");
              if (end < 0) return;
              const lines = head.slice(0, end).split("\r\n");
              const ok = /^HTTP\/1\.1 101/.test(lines[0] ?? "") && lines.some((l) => l.toLowerCase().startsWith("sec-websocket-accept:") && l.slice(l.indexOf(":") + 1).trim() === accept);
              if (!ok) {
                fail(new Error(`The Codex daemon refused the connection (${lines[0] ?? "no answer"}).`));
                this.socket?.end();
                return;
              }
              upgraded = true;
              clearTimeout(timer);
              resolve();
              const rest = Buffer.from(head.slice(end + 4), "latin1");
              if (rest.length) this.onBytes(new Uint8Array(rest));
              return;
            }
            this.onBytes(chunk);
          },
          drain: () => this.flush(),
          close: () => {
            if (!upgraded) fail(new Error("The Codex daemon closed the connection."));
            this.end("closed");
          },
          error: (_s, e) => {
            if (!upgraded) fail(e);
            this.end(e?.message ?? "error");
          },
        },
      }).catch((e) => fail(e instanceof Error ? e : new Error(String(e))));
    });
  }

  private onBytes(chunk: Uint8Array) {
    for (const f of this.reader.push(chunk)) {
      switch (f.opcode) {
        case 0x0: // continuation
        case 0x1: // text
        case 0x2: // binary
          this.parts.push(f.payload);
          if (f.fin) {
            const total = this.parts.reduce((n, p) => n + p.length, 0);
            const all = new Uint8Array(total);
            let o = 0;
            for (const p of this.parts) all.set(p, (o += p.length) - p.length);
            this.parts = [];
            try {
              this.h.message(this.dec.decode(all));
            } catch (e) {
              console.error("codex: a message handler failed:", e);
            }
          }
          break;
        case 0x8: // close
          this.write(encodeFrame(0x8, new Uint8Array(0)));
          this.socket?.end();
          this.end("closed by the daemon");
          break;
        case 0x9: // ping
          this.write(encodeFrame(0xa, f.payload));
          break;
      }
    }
  }

  private write(bytes: Uint8Array) {
    if (!this.socket || this.closed) return;
    if (this.pending.length) return void this.pending.push(bytes);
    const n = this.socket.write(bytes);
    if (n < bytes.length) this.pending.push(bytes.slice(n));
  }

  private flush() {
    while (this.pending.length && this.socket) {
      const b = this.pending[0]!;
      const n = this.socket.write(b);
      if (n < b.length) {
        this.pending[0] = b.slice(n);
        return;
      }
      this.pending.shift();
    }
  }

  send(text: string) {
    if (this.closed) throw new Error("The connection to the Codex daemon is closed.");
    this.write(encodeFrame(0x1, this.enc.encode(text)));
  }

  get isOpen() {
    return !this.closed;
  }

  close() {
    if (this.closed) return;
    this.write(encodeFrame(0x8, new Uint8Array([0x03, 0xe8])));
    this.socket?.end();
    this.end("closed");
  }

  private end(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.h.close(reason);
  }
}
