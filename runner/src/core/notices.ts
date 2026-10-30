// Tether's own notices (denials, start errors, "Claude Code stopped", a turn cut off) are in no
// harness store, so they're kept here, small, in the runner's config dir (notices.json, mode 600),
// keyed by session: a session that leaves memory, or a runner that restarts, still shows them.
//
// `!` command cards (core/shellRuns.ts) are bigger and change more often: each session's cards are
// kept in a file of their own (shell-cards/<hash>.json beside notices.json), and only the files
// that changed are written, at most once a second (at once when a card settles). A running card is
// never dropped: it carries the process group a crashed runner's next start must end.

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
/** `!` command cards are kept apart from that limit: this many more per session (running ones always). */
const SHELL_CARDS = 30;
const SESSIONS = 300;

const isCard = (n: OverlayNotice) => !!n.msg.shell;

/** Writes `data` to `file` (mode 600) through a temporary file, so a crash never leaves half of it. */
function writeAtomic(file: string, data: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export class NoticeStore {
  private map: Record<string, { at: number; notices: OverlayNotice[] }> = {};
  private timer?: ReturnType<typeof setTimeout>;
  /** notices.json needs writing */
  private plainDirty = false;
  /** sessions whose card file needs writing */
  private cardsDirty = new Set<string>();
  private readonly cardsDir?: string;

  /** `file` undefined: kept in memory only (tests). */
  constructor(private file?: string) {
    if (!file) return;
    this.cardsDir = join(dirname(file), "shell-cards");
    try {
      this.map = JSON.parse(readFileSync(file, "utf8"));
      // Cards kept in notices.json by an older runner move to their own files.
      for (const [id, e] of Object.entries(this.map))
        if (e.notices.some(isCard)) {
          this.cardsDirty.add(id);
          this.plainDirty = true;
        }
    } catch {}
    try {
      for (const f of readdirSync(this.cardsDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const { sessionId, at, cards } = JSON.parse(readFileSync(join(this.cardsDir, f), "utf8")) as { sessionId: string; at: number; cards: OverlayNotice[] };
          const e = (this.map[sessionId] ??= { at, notices: [] });
          const have = new Set(e.notices.map((n) => n.msg.id));
          e.notices = [...e.notices, ...cards.filter((c) => !have.has(c.msg.id))].sort((x, y) => x.msg.ts - y.msg.ts);
          e.at = Math.max(e.at, at);
        } catch {}
      }
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
    this.map[sessionId] = { at: Date.now(), notices: keep([...had, { ...n, msg: { ...n.msg, parts } }]) };
    this.dirty(sessionId, isCard(n));
    const ids = Object.keys(this.map);
    if (ids.length > SESSIONS)
      for (const id of ids.sort((a, b) => this.map[a]!.at - this.map[b]!.at).slice(0, ids.length - SESSIONS)) {
        delete this.map[id];
        this.dirty(id, true);
        this.plainDirty = true;
      }
    this.later();
  }

  /** A kept message changed (a `!` command's card moved on): saved as given, where it was. */
  update(sessionId: string, msg: Msg) {
    const e = this.map[sessionId];
    const i = e?.notices.findIndex((x) => x.msg.id === msg.id) ?? -1;
    if (!e || i < 0) return;
    e.notices[i] = { ...e.notices[i]!, msg };
    this.dirty(sessionId, !!msg.shell);
    this.later();
  }

  /** Changes kept messages in every session (`fn` returns the new one, or undefined to keep it). */
  rewrite(fn: (sessionId: string, msg: Msg) => Msg | undefined) {
    let any = false;
    for (const [id, e] of Object.entries(this.map))
      e.notices = e.notices.map((n) => {
        const m = fn(id, n.msg);
        if (!m) return n;
        any = true;
        this.dirty(id, !!m.shell);
        return { ...n, msg: m };
      });
    if (any) this.later();
  }

  /** Replaces a session's notices (after pruning). */
  set(sessionId: string, notices: OverlayNotice[]) {
    const had = this.map[sessionId]?.notices ?? [];
    if (had.length === notices.length) return;
    if (notices.length) this.map[sessionId] = { at: Date.now(), notices };
    else delete this.map[sessionId];
    this.dirty(sessionId, true);
    this.plainDirty = true;
    this.later();
  }

  private dirty(sessionId: string, card: boolean) {
    if (card) this.cardsDirty.add(sessionId);
    else this.plainDirty = true;
  }

  /** Written within a second, however often things change meanwhile (one write for many updates). */
  private later() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1000);
    this.timer.unref?.();
  }

  /** Writes what changed: notices.json, and the card file of each session whose cards changed. */
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.file) return;
    try {
      if (this.plainDirty) {
        const plain = Object.fromEntries(
          Object.entries(this.map)
            .map(([id, e]) => [id, { at: e.at, notices: e.notices.filter((n) => !isCard(n)) }] as const)
            .filter(([, e]) => e.notices.length),
        );
        writeAtomic(this.file, JSON.stringify(plain));
        this.plainDirty = false;
      }
      for (const id of this.cardsDirty) {
        const f = this.cardFile(id);
        const cards = this.map[id]?.notices.filter(isCard) ?? [];
        if (cards.length) writeAtomic(f, JSON.stringify({ sessionId: id, at: this.map[id]!.at, cards }));
        else rmSync(f, { force: true });
      }
      this.cardsDirty.clear();
    } catch {}
  }

  private cardFile(sessionId: string) {
    return join(this.cardsDir!, `${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}.json`);
  }
}

/**
 * The newest PER_SESSION notices and the newest SHELL_CARDS command cards, in order; a running card
 * is always kept (it is how a crashed runner's next start finds what still runs).
 */
function keep(list: OverlayNotice[]): OverlayNotice[] {
  const running = list.filter((n) => n.msg.shell?.state === "running" || n.msg.shell?.pgid);
  const cards = list.filter((n) => isCard(n) && !running.includes(n));
  const rest = list.filter((n) => !isCard(n));
  const kept = new Set([...running, ...cards.slice(-SHELL_CARDS), ...rest.slice(-PER_SESSION)]);
  return list.filter((n) => kept.has(n));
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
    // A running card stays whatever happened: it carries the process group to end after a crash.
    return !anchor || ids.has(anchor) || latest <= n.msg.ts || n.msg.shell?.state === "running" || !!n.msg.shell?.pgid;
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

/**
 * Tool calls left running before one of Tether's warnings or errors (the process stopped, a turn
 * cut off by a restart) never finished: they show as failed, not spinning forever. Live, the core
 * does the same when its driver goes away (live.ts toStored), so both read alike.
 */
export function settleStopped(msgs: Msg[]): Msg[] {
  let stop = -1;
  msgs.forEach((m, i) => {
    if (m.role === "notice" && m.id.startsWith("n-") && (m.level === "error" || m.level === "warning")) stop = i;
  });
  if (stop < 0) return msgs;
  return msgs.map((m, i) =>
    i < stop && m.parts.some((p) => p.type === "tool" && p.status === "running")
      ? { ...m, parts: m.parts.map((p) => (p.type === "tool" && p.status === "running" ? { ...p, status: "error" as const } : p)) }
      : m,
  );
}
