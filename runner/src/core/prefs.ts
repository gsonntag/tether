// Per-session settings (model, effort, permission mode) and open requests, kept in runner.json
// (SPEC §4, §7), so a session picks up where it was after it goes stored or the runner restarts.
// Settings are saved shortly after a change, open requests at once; atomically, with the rest of
// the file left as it is.

import { readFileSync } from "node:fs";
import { CONFIG_FILE, saveConfig, type RunnerConfig, type SessionPrefs } from "../config";
import { redactValue } from "../credentials";
import { cleanGrants, type RunnerGrant } from "../../../shared/access";
import type { BillingSource } from "../../../shared/credentials";
import type { RunnerSettings } from "../../../shared/protocol";
import type { HarnessId } from "../../../shared/transcript";
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
/** A message scheduled far ahead (SPEC §9) keeps its session's entry however old it is. */
const timed = (p: SessionPrefs) => Array.isArray(p.queue) && p.queue.some((m) => typeof m?.at === "number");
/** Entries kept whatever their age: a replaced thread (the only thing that says so), a pin, an archive, a scheduled message. */
const keep = (p: SessionPrefs) => !!(p.carried || p.pinned || p.archived || timed(p));
/** Carried, scheduled and pinned entries first, so the cap cuts them last. Archived ones sort by age with the rest: they never expire, so ranking them up too would crowd out every new entry. */
const rank = (p: SessionPrefs) => (p.carried ? 3 : timed(p) ? 2 : p.pinned ? 1 : 0);

export class Prefs {
  private map: Record<string, SessionPrefs>;
  private timer?: ReturnType<typeof setTimeout>;
  /** something changed since the last write (nothing is written otherwise) */
  private dirty = false;

  private open: SavedRequest[];
  private closed: ClosedRequest[];
  private runnerSettings: RunnerSettings;
  private alive?: number;
  private sharedWith: RunnerGrant[];

  constructor(
    private file = CONFIG_FILE,
    private delayMs = 300,
  ) {
    const cfg = read(file);
    this.map = { ...(cfg.sessions ?? {}) };
    this.open = Array.isArray(cfg.requests) ? cfg.requests : [];
    this.closed = Array.isArray(cfg.closedRequests) ? cfg.closedRequests : [];
    this.runnerSettings = cfg.settings && typeof cfg.settings === "object" ? { ...cfg.settings } : {};
    this.alive = typeof cfg.aliveAt === "number" && Number.isFinite(cfg.aliveAt) ? cfg.aliveAt : undefined;
    for (const [id, p] of Object.entries(this.map)) this.index(id, undefined, p.sideOf);
    this.sharedWith = cleanGrants(cfg.sharedWith);
  }

  /** When the runner was last seen running (as saved: from before this start, until set). */
  aliveAt(): number | undefined {
    return this.alive;
  }

  /** The runner is running now (saved with the next write). */
  setAliveAt(t: number | undefined) {
    this.alive = t;
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  /** Side chats by the session they're beside (SPEC §16a), kept as prefs change. */
  private sides = new Map<string, Set<string>>();
  private index(id: string, was: string | undefined, now: string | undefined) {
    if (was === now) return;
    if (was) this.sides.get(was)?.delete(id);
    if (now) {
      let set = this.sides.get(now);
      if (!set) this.sides.set(now, (set = new Set()));
      set.add(id);
    }
  }

  /** The side chats beside a session. */
  sideChatsOf(parentId: string): string[] {
    return [...(this.sides.get(parentId) ?? [])];
  }

  /** A session went on under a new id: its side chats are beside that one now. */
  moveSides(from: string, to: string) {
    if (from === to) return;
    for (const id of this.sideChatsOf(from)) this.set(id, { sideOf: to });
  }

  /** Who else may use this runner (runner.json `sharedWith`). */
  shared(): RunnerGrant[] {
    return this.sharedWith.map((g) => ({ ...g }));
  }

  /** Replaces who else may use this runner (cleaned; empty removes it): written at once. */
  setShared(people: unknown): RunnerGrant[] {
    this.sharedWith = cleanGrants(people);
    this.flush();
    const cfg = read(this.file);
    if (cfg.runnerId) {
      const { sharedWith: _, ...rest } = cfg;
      saveConfig({ ...rest, runnerId: cfg.runnerId, ...(this.sharedWith.length ? { sharedWith: this.sharedWith } : {}) }, this.file);
    }
    return this.shared();
  }

  /** The runner-wide settings. */
  settings(): RunnerSettings {
    return { ...this.runnerSettings };
  }

  /** Changes runner-wide settings (only known keys): written at once. */
  setSettings(patch: RunnerSettings): RunnerSettings {
    if (typeof patch.backgroundSubagents === "boolean") this.runnerSettings.backgroundSubagents = patch.backgroundSubagents || undefined;
    if (this.runnerSettings.backgroundSubagents === undefined) delete this.runnerSettings.backgroundSubagents;
    // On unless turned off: only `false` is kept.
    if (patch.conciseReplies === true) delete this.runnerSettings.conciseReplies;
    else if (patch.conciseReplies === false) this.runnerSettings.conciseReplies = false;
    this.dirty = true;
    this.flush();
    return this.settings();
  }


  /** Sets runner.json's `name` (blank removes it): written at once. */
  setName(name: string) {
    this.flush();
    const cfg = read(this.file);
    if (!cfg.runnerId) return;
    const { name: _, ...rest } = cfg;
    saveConfig({ ...rest, runnerId: cfg.runnerId, ...(name ? { name } : {}) }, this.file);
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

  /** Sessions whose turn was running when the runner last stopped. */
  running(): string[] {
    return Object.entries(this.map)
      .filter(([, p]) => p.running)
      .map(([id]) => id);
  }

  /** Sessions whose TUI hadn't been seen gone when the runner last stopped, with what was saved at its start. */
  inTerminal(): [string, NonNullable<SessionPrefs["tui"]>][] {
    return Object.entries(this.map).flatMap(([id, p]) => (p.tui ? [[id, p.tui] as [string, NonNullable<SessionPrefs["tui"]>]] : []));
  }

  /** Sessions whose prefs pass `f`. */
  ids(f: (p: SessionPrefs) => boolean): string[] {
    return Object.entries(this.map)
      .filter(([, p]) => f(p))
      .map(([id]) => id);
  }

  /** Sessions with messages waiting in their queue. */
  queued(): string[] {
    return Object.entries(this.map)
      .filter(([, p]) => Array.isArray(p.queue) && p.queue.length > 0)
      .map(([id]) => id);
  }

  /** Pinned sessions (SessionPrefs.pinned), but one that went on under another id. */
  pinned(): string[] {
    return Object.entries(this.map).filter(([, p]) => p.pinned && !p.movedTo && !p.carried && !p.carrying).map(([id]) => id);
  }

  retrying(): string[] {
    return Object.entries(this.map).filter(([, p]) => p.retry !== undefined).map(([id]) => id);
  }

  set(id: string, patch: SessionPrefs) {
    patch = redactValue(patch);
    const was = this.map[id]?.sideOf;
    this.map[id] = { ...this.map[id], ...patch, at: Date.now() };
    for (const k of Object.keys(this.map[id]!) as (keyof SessionPrefs)[]) if (this.map[id]![k] === undefined) delete this.map[id]![k];
    this.index(id, was, this.map[id]!.sideOf);
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
      // A replaced thread stays out of the lists for good: this is the only thing that says so.
      .filter(([, p]) => keep(p) || (p.at ?? 0) >= cutoff)
      .sort((a, b) => rank(b[1]) - rank(a[1]) || (b[1].at ?? 0) - (a[1].at ?? 0))
      .slice(0, MAX_ENTRIES);
    this.map = Object.fromEntries(kept);
    // Reread, so a name edited by hand meanwhile isn't overwritten.
    const cfg = read(this.file);
    if (!cfg.runnerId) return; // not a runner's file: never invent one here
    const { requests: _, closedRequests: __, settings: ___, aliveAt: ____, ...rest } = cfg;
    saveConfig(
      { ...rest, runnerId: cfg.runnerId, ...(this.alive !== undefined ? { aliveAt: this.alive } : {}), ...(Object.keys(this.runnerSettings).length ? { settings: this.runnerSettings } : {}), sessions: this.map, ...(this.open.length ? { requests: this.open } : {}), ...(this.closed.length ? { closedRequests: this.closed } : {}) },
      this.file,
    );
  }
}
