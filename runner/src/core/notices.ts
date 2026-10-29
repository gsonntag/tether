// Tether's own notices (denials, start errors, "Claude Code stopped", a turn cut off) are in no
// harness store, so they're kept here, small, in the runner's config dir (notices.json, mode 600),
// keyed by session: a session that leaves memory, or a runner that restarts, still shows them.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Msg } from "../../../shared/transcript";

/**
 * A notice and where it goes in a transcript read from the store: after message `after`, or, with
 * `turnOf`, at the end of the turn that prompt started (before the next prompt you typed).
 */
export interface OverlayNotice {
  msg: Msg;
  after?: string;
  turnOf?: string;
}

const PER_SESSION = 50;
const SESSIONS = 300;

export class NoticeStore {
  private map: Record<string, { at: number; notices: OverlayNotice[] }> = {};
  private timer?: ReturnType<typeof setTimeout>;

  /** `file` undefined: kept in memory only (tests). */
  constructor(private file?: string) {
    if (!file) return;
    try {
      this.map = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
  }

  get(sessionId: string): OverlayNotice[] {
    return [...(this.map[sessionId]?.notices ?? [])];
  }

  add(sessionId: string, n: OverlayNotice) {
    const had = this.map[sessionId]?.notices ?? [];
    if (had.some((x) => x.msg.id === n.msg.id)) return;
    // Long texts (a crash's stderr) are cut: this file stays small.
    const parts = n.msg.parts.map((p) => (p.type === "text" && p.text.length > 2000 ? { ...p, text: `${p.text.slice(0, 2000)}…` } : p));
    this.map[sessionId] = { at: Date.now(), notices: [...had, { ...n, msg: { ...n.msg, parts } }].slice(-PER_SESSION) };
    const ids = Object.keys(this.map);
    if (ids.length > SESSIONS) for (const id of ids.sort((a, b) => this.map[a]!.at - this.map[b]!.at).slice(0, ids.length - SESSIONS)) delete this.map[id];
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
    this.timer.unref?.();
  }

  /** Replaces a session's notices (after pruning). */
  set(sessionId: string, notices: OverlayNotice[]) {
    const had = this.map[sessionId]?.notices ?? [];
    if (had.length === notices.length) return;
    if (notices.length) this.map[sessionId] = { at: Date.now(), notices };
    else delete this.map[sessionId];
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
    this.timer.unref?.();
  }

  flush() {
    clearTimeout(this.timer);
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.map), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
    } catch {}
  }
}

/**
 * The notices still worth showing: one whose anchor (the prompt or message it follows) is no
 * longer in the store, which has moved on since it was written (a rewind, a /clear), goes;
 * otherwise it would sit at the bottom forever.
 */
export function pruneOverlay(store: Msg[], overlay: OverlayNotice[]): OverlayNotice[] {
  if (!overlay.length) return overlay;
  const ids = new Set(store.map((m) => m.id));
  const latest = store.reduce((t, m) => Math.max(t, m.ts), 0);
  return overlay.filter((n) => {
    const anchor = n.turnOf ?? n.after;
    return !anchor || ids.has(anchor) || latest <= n.msg.ts;
  });
}

/** A transcript read from the store with Tether's own notices put back where they belong. */
export function withOverlay(store: Msg[], overlay: OverlayNotice[]): Msg[] {
  if (!overlay.length) return store;
  const out = [...store];
  const have = new Set(out.map((m) => m.id));
  const typed = (m: Msg) => m.role === "user" && !m.origin;
  for (const { msg, after, turnOf } of overlay) {
    if (have.has(msg.id)) continue;
    let at = out.length;
    if (turnOf) {
      const i = out.findIndex((m) => m.id === turnOf);
      if (i >= 0) {
        const next = out.findIndex((m, j) => j > i && typed(m) && !m.id.startsWith("n-"));
        at = next < 0 ? out.length : next;
        // Other notices at the end of that turn stay before this one.
      }
    } else if (after) {
      const i = out.findIndex((m) => m.id === after);
      if (i >= 0) {
        at = i + 1;
        // After the notices already put there: they came first.
        while (at < out.length && out[at]!.id.startsWith("n-")) at++;
      }
    }
    out.splice(at, 0, msg);
    have.add(msg.id);
  }
  return out;
}
