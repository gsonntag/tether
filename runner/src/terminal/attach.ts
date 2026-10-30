// One PTY per attached browser (SPEC §8 Streaming): each runs `tmux attach` to a terminal's tmux
// session, and its output goes to that browser only, as `term` frames keyed by attachId. Input and
// resizes come back by attachId. The relay routes them and never broadcasts or stores them.
//
// Output is coalesced for a few milliseconds, so a burst of tiny writes is one frame. There is no
// read-side flow control (docs/notes/pty.md), so an attach whose connection falls far behind ends
// (termEnd "too slow") instead of dropping bytes: the browser reattaches and tmux redraws.

import { decodeChunk, encodeChunk } from "../../../shared/wire";
import type { RunnerToServer } from "../../../shared/protocol";
import { spawnPty, type Pty, type PtyOptions } from "./pty";

export type SpawnPty = (argv: string[], opts: PtyOptions) => Pty;

export interface AttachSink {
  /** false when there is no connection (the frame is dropped; the relay forgot the attach anyway) */
  send(m: RunnerToServer): boolean;
  /** bytes waiting in the connection's send buffer */
  buffered(): number;
}

interface Attach {
  id: string;
  /** the tmux session it shows */
  target: string;
  pty: Pty;
  chunks: Uint8Array[];
  size: number;
  timer?: ReturnType<typeof setTimeout>;
  /** ended by us (closed, detached, too slow): its exit says nothing */
  ended: boolean;
}

export interface AttachOptions {
  spawn?: SpawnPty;
  /** how long output is gathered before a frame goes out */
  flushMs?: number;
  /** a frame goes out at once past this many bytes */
  frameBytes?: number;
  /** the connection's buffer past this ends the attach */
  maxBuffered?: number;
  /** an attach's PTY ended by itself (tmux detached it, or its session is gone) */
  onExit?: (target: string, attachId: string) => void;
}

export const MAX_ATTACHES = 64;

export class Attaches {
  private map = new Map<string, Attach>();
  private spawn: SpawnPty;
  private flushMs: number;
  private frameBytes: number;
  private maxBuffered: number;

  constructor(
    private sink: AttachSink,
    private o: AttachOptions = {},
  ) {
    this.spawn = o.spawn ?? spawnPty;
    this.flushMs = o.flushMs ?? 8;
    this.frameBytes = o.frameBytes ?? 64 * 1024;
    this.maxBuffered = o.maxBuffered ?? 8 * 1024 * 1024;
  }

  get size() {
    return this.map.size;
  }

  has(id: string) {
    return this.map.has(id);
  }

  /** The tmux session an attach shows. */
  targetOf(id: string): string | undefined {
    return this.map.get(id)?.target;
  }

  /** The attaches showing a tmux session. */
  of(target: string): string[] {
    return [...this.map.values()].filter((a) => a.target === target).map((a) => a.id);
  }

  /** Starts a PTY running `argv` (a `tmux attach`) for this attach id. */
  open(id: string, target: string, argv: string[], cols: number, rows: number, env?: Record<string, string>) {
    if (this.map.has(id)) throw new Error("That terminal is already attached.");
    if (this.map.size >= MAX_ATTACHES) throw new Error("Too many terminals are open on this runner. Close some first.");
    const a: Attach = { id, target, pty: undefined as unknown as Pty, chunks: [], size: 0, ended: false };
    a.pty = this.spawn(argv, {
      cols: size(cols, 80),
      rows: size(rows, 24),
      env,
      onData: (bytes) => this.data(a, bytes),
      onExit: () => {
        if (this.map.get(id) !== a) return;
        this.flush(a);
        this.map.delete(id);
        if (a.ended) return;
        this.sink.send({ t: "termEnd", attachId: id, reason: "exited" });
        this.o.onExit?.(target, id);
      },
    });
    this.map.set(id, a);
  }

  input(id: string, data: string) {
    const a = this.need(id);
    a.pty.write(decodeChunk(data));
  }

  resize(id: string, cols: number, rows: number) {
    this.need(id).pty.resize(size(cols, 80), size(rows, 24));
  }

  /** The browser closed it (or went away): no termEnd, it knows. */
  close(id: string) {
    const a = this.map.get(id);
    if (!a) return;
    this.end(a);
  }

  /** Ends an attach and tells its browser why. */
  endWith(id: string, reason: string) {
    const a = this.map.get(id);
    if (!a) return;
    this.flush(a);
    this.end(a);
    this.sink.send({ t: "termEnd", attachId: id, reason });
  }

  /** Every attach of a tmux session that is gone. */
  endTarget(target: string, reason: string) {
    for (const id of this.of(target)) this.endWith(id, reason);
  }

  closeAll() {
    for (const a of [...this.map.values()]) this.end(a);
  }

  private end(a: Attach) {
    a.ended = true;
    clearTimeout(a.timer);
    this.map.delete(a.id);
    a.pty.close();
  }

  private need(id: string): Attach {
    const a = this.map.get(id);
    if (!a) throw new Error("That terminal isn't attached any more.");
    return a;
  }

  private data(a: Attach, bytes: Uint8Array) {
    if (a.ended) return;
    // Copied: the PTY may reuse its buffer.
    a.chunks.push(bytes.slice());
    a.size += bytes.length;
    if (a.size >= this.frameBytes) return this.flush(a);
    a.timer ??= setTimeout(() => this.flush(a), this.flushMs);
  }

  private flush(a: Attach) {
    clearTimeout(a.timer);
    a.timer = undefined;
    if (!a.size) return;
    const all = new Uint8Array(a.size);
    let at = 0;
    for (const c of a.chunks) all.set(c, at), (at += c.length);
    a.chunks = [];
    a.size = 0;
    if (a.ended) return;
    if (this.sink.buffered() > this.maxBuffered) {
      // Never a silent gap: the browser reattaches and tmux draws the screen again.
      this.end(a);
      this.sink.send({ t: "termEnd", attachId: a.id, reason: "too slow" });
      return;
    }
    // Disconnected: the relay has dropped the attach and told nobody; nothing to keep.
    if (!this.sink.send({ t: "term", attachId: a.id, data: encodeChunk(all) })) this.end(a);
  }
}

const size = (v: number, d: number) => Math.max(2, Math.min(1000, Math.floor(Number(v)) || d));
