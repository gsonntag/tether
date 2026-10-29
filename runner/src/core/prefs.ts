// Per-session settings (model, effort, permission mode) and open requests, kept in runner.json
// (SPEC §4, §7), so a session picks up where it was after it goes stored or the runner restarts.
// Settings are saved shortly after a change, open requests at once; atomically, with the rest of
// the file left as it is.

import { readFileSync } from "node:fs";
import { CONFIG_FILE, saveConfig, type RunnerConfig, type SessionPrefs } from "../config";
import type { ClosedRequest, SavedRequest } from "./broker";

/** runner.json as it is, without creating it (index.ts's loadConfig does that at start). */
function read(file: string): Partial<RunnerConfig> {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** Entries untouched this long are dropped on save. */
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2000;

export class Prefs {
  private map: Record<string, SessionPrefs>;
  private timer?: ReturnType<typeof setTimeout>;
  /** something changed since the last write (nothing is written otherwise) */
  private dirty = false;

  private open: SavedRequest[];
  private closed: ClosedRequest[];

  constructor(
    private file = CONFIG_FILE,
    private delayMs = 300,
  ) {
    const cfg = read(file);
    this.map = { ...(cfg.sessions ?? {}) };
    this.open = Array.isArray(cfg.requests) ? cfg.requests : [];
    this.closed = Array.isArray(cfg.closedRequests) ? cfg.closedRequests : [];
  }

  /** The open requests saved last time. */
  requests(): SavedRequest[] {
    return [...this.open];
  }

  /** Request ids closed lately (saved last time). */
  closedRequests(): ClosedRequest[] {
    return [...this.closed];
  }

  /** The open requests now, and those closed lately: written at once (a request matters more than a few ms). */
  setRequests(list: SavedRequest[], closed: ClosedRequest[] = this.closed) {
    this.open = list;
    this.closed = closed;
    this.dirty = true;
    this.flush();
  }

  get(id: string): SessionPrefs {
    return this.map[id] ?? {};
  }

  set(id: string, patch: SessionPrefs) {
    this.map[id] = { ...this.map[id], ...patch, at: Date.now() };
    for (const k of Object.keys(this.map[id]!) as (keyof SessionPrefs)[]) if (this.map[id]![k] === undefined) delete this.map[id]![k];
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  /** Writes now (also on shutdown). */
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return;
    this.dirty = false;
    const cutoff = Date.now() - MAX_AGE_MS;
    const kept = Object.entries(this.map)
      .filter(([, p]) => (p.at ?? 0) >= cutoff)
      .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
      .slice(0, MAX_ENTRIES);
    this.map = Object.fromEntries(kept);
    // Reread, so a name edited by hand meanwhile isn't overwritten.
    const cfg = read(this.file);
    if (!cfg.runnerId) return; // not a runner's file: never invent one here
    const { requests: _, closedRequests: __, ...rest } = cfg;
    saveConfig(
      { ...rest, runnerId: cfg.runnerId, sessions: this.map, ...(this.open.length ? { requests: this.open } : {}), ...(this.closed.length ? { closedRequests: this.closed } : {}) },
      this.file,
    );
  }
}
