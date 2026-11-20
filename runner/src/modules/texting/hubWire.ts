// Calls between a runner and its texting hub (shared/textingHub.ts), over the app: `call` sends a
// req and waits for its res; files go first, in HUB_CHUNK pieces, paced so the socket's buffer
// never nears the server's limit. The other end's `handle` answers. Nothing is kept across a
// reconnect: a call whose answer doesn't come times out, and half-sent files are dropped after
// HUB_FILE_TTL_MS.

import { decodeChunk, encodeChunk } from "../../../../shared/wire";
import { HUB_BUFFER_MAX, HUB_CHUNK, HUB_FILE_MAX, HUB_FILE_TTL_MS, HUB_PENDING_MAX, type HubFileRef, type HubFrame } from "../../../../shared/textingHub";

/** A file's bytes, as a call carries them. */
export interface WireFile {
  name: string;
  mimeType: string;
  data: Uint8Array;
}

/** What the wire needs from the runner's connection (core/hubPort.ts). */
export interface HubPost {
  post(to: string, m: HubFrame): boolean;
  buffered(): number;
  onFrame(f: (from: string, m: HubFrame) => void): () => void;
}

export type HubHandler = (from: string, op: string, args: unknown, files: WireFile[]) => Promise<unknown>;

/** A call that got no answer in time: it may or may not have happened at the other end (`timedOut`, as connector.ts withTimeout). */
const late = (what: string, ms: number) => Object.assign(new Error(`The other computer didn't answer within ${Math.round(ms / 1000)}s`), { timedOut: what });

export class HubWire {
  private seq = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  /** files coming in, by sender and transfer */
  private incoming = new Map<string, { from: string; parts: Uint8Array[]; size: number; next: number; done: boolean; bad?: string; timer: ReturnType<typeof setTimeout> }>();
  private handler?: HubHandler;
  private off?: () => void;
  /** a run of this process: transfer and call ids never repeat across restarts */
  private run = crypto.randomUUID().slice(0, 8);

  constructor(
    private port: HubPost,
    private log: (line: string) => void = () => {},
    /** how long pacing waits for the buffer to drain before giving up on a file */
    private drainMs = 60_000,
  ) {}

  start() {
    this.off ??= this.port.onFrame((from, m) => this.frame(from, m));
  }

  stop() {
    this.off?.();
    this.off = undefined;
    for (const [, p] of this.pending) (clearTimeout(p.timer), p.reject(new Error("Texting stopped.")));
    this.pending.clear();
    for (const [, f] of this.incoming) clearTimeout(f.timer);
    this.incoming.clear();
  }

  /** Answers the other end's calls. */
  handle(h: HubHandler) {
    this.handler = h;
  }

  /**
   * Calls `op` on runner `to` with `files` (sent first): its answer, or throws its error. No answer
   * in `timeoutMs` throws with `timedOut: what`.
   */
  async call(to: string, op: string, args: unknown, o: { files?: WireFile[]; timeoutMs?: number; what?: string } = {}): Promise<unknown> {
    const timeoutMs = o.timeoutMs ?? 30_000;
    const refs: HubFileRef[] = [];
    for (const f of o.files ?? []) refs.push(await this.upload(to, f));
    const rid = `${this.run}-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(late(o.what ?? op, timeoutMs));
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(rid, { resolve, reject, timer });
      if (!this.port.post(to, { k: "req", rid, op, args, ...(refs.length ? { files: refs } : {}) })) {
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(new Error("Not connected to the app."));
      }
    });
  }

  /** Sends one file's bytes as chunks, waiting whenever the socket's buffer is full. */
  private async upload(to: string, f: WireFile): Promise<HubFileRef> {
    if (f.data.byteLength > HUB_FILE_MAX) throw new Error(`${f.name} is too big to pass on.`);
    const x = `${this.run}-f${++this.seq}`;
    const total = Math.max(1, Math.ceil(f.data.byteLength / HUB_CHUNK));
    for (let i = 0; i < total; i++) {
      const until = Date.now() + this.drainMs;
      while (this.port.buffered() > HUB_BUFFER_MAX) {
        if (Date.now() > until) throw new Error("The connection to the app is too slow to pass a file on.");
        await new Promise((r) => setTimeout(r, 50));
      }
      const piece = f.data.subarray(i * HUB_CHUNK, (i + 1) * HUB_CHUNK);
      if (!this.port.post(to, { k: "chunk", x, i, data: encodeChunk(piece), ...(i === total - 1 ? { end: true } : {}) })) throw new Error("Not connected to the app.");
    }
    return { x, name: f.name, mimeType: f.mimeType };
  }

  private frame(from: string, m: HubFrame) {
    if (m.k === "res") {
      const p = this.pending.get(m.rid);
      if (!p) return;
      this.pending.delete(m.rid);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.data);
      else p.reject(new Error(m.error || "The other computer couldn't do that."));
      return;
    }
    if (m.k === "chunk") return this.chunk(from, m);
    void this.request(from, m);
  }

  private chunk(from: string, m: Extract<HubFrame, { k: "chunk" }>) {
    const key = `${from}\u0000${m.x}`;
    let f = this.incoming.get(key);
    if (!f) {
      if (m.i !== 0) return;
      f = { from, parts: [], size: 0, next: 0, done: false, timer: setTimeout(() => {}, 0) };
      this.incoming.set(key, f);
    }
    clearTimeout(f.timer);
    f.timer = setTimeout(() => this.incoming.delete(key), HUB_FILE_TTL_MS);
    (f.timer as { unref?: () => void }).unref?.();
    if (f.bad || f.done) return;
    if (m.i !== f.next) return void this.spoil(f, "A file came through out of order.");
    let bytes: Uint8Array;
    try {
      bytes = decodeChunk(m.data);
    } catch {
      return void this.spoil(f, "A file came through damaged.");
    }
    const fromNow = [...this.incoming.values()].filter((x) => x.from === from).reduce((n, x) => n + x.size, 0);
    if (f.size + bytes.byteLength > HUB_FILE_MAX || fromNow + bytes.byteLength > HUB_PENDING_MAX) return void this.spoil(f, "A file was too big to pass on.");
    f.parts.push(bytes);
    f.size += bytes.byteLength;
    f.next++;
    if (m.end) f.done = true;
  }

  private spoil(f: { parts: Uint8Array[]; size: number; bad?: string }, why: string) {
    f.bad = why;
    f.parts = [];
    f.size = 0;
  }

  private async request(from: string, m: Extract<HubFrame, { k: "req" }>) {
    const answer = (r: { ok: true; data: unknown } | { ok: false; error: string }) => void this.port.post(from, { k: "res", rid: m.rid, ...r });
    const files: WireFile[] = [];
    let problem: string | undefined;
    for (const ref of m.files ?? []) {
      const key = `${from}\u0000${ref.x}`;
      const f = this.incoming.get(key);
      this.incoming.delete(key);
      if (f) clearTimeout(f.timer);
      if (!f || !f.done || f.bad) {
        problem ??= f?.bad ?? "A file didn't come through.";
        continue;
      }
      const data = new Uint8Array(f.size);
      let at = 0;
      for (const p of f.parts) (data.set(p, at), (at += p.byteLength));
      files.push({ name: ref.name, mimeType: ref.mimeType, data });
    }
    if (problem) return answer({ ok: false, error: problem });
    if (!this.handler) return answer({ ok: false, error: "Texting isn't running on that computer." });
    try {
      const data = await this.handler(from, m.op, m.args, files);
      answer({ ok: true, data: data ?? null });
    } catch (e: any) {
      this.log(`texting hub: ${m.op} from ${from} failed: ${e?.message ?? e}`);
      answer({ ok: false, error: String(e?.message ?? e).slice(0, 500) });
    }
  }
}
