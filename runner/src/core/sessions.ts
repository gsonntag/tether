// The session core (SPEC §3, §4, §5): the session registry, stored and live modes, event
// numbering, snapshots and pages, and the summary list. Driving a live session (drivers, sinks,
// idle close) is in live.ts; the rpc ops that call into this are in sessionOps.ts.
//
// Sessions are opened lazily: a Session object exists while someone has it open, while it is live,
// or while a subagent of it runs. Its transcript is read from the harness's store on first open
// (never kept on disk by Tether) and tailed while it's stored and watched.

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { partChunk, type PartChunk } from "../../../shared/limits";
import type { RunnerToServer } from "../../../shared/protocol";
import { parseSessionId, sessionId } from "../../../shared/ids";
import type { HarnessId, LiveState, Msg, ProjectInfo, SessionEvent, SessionSnapshot, SessionSummary } from "../../../shared/transcript";
import { TRANSCRIPT_PAGE } from "../../../shared/transcript";
import type { Adapter, StartOpts } from "./adapter";
import type { EventBus } from "./bus";
import type { CoreEvents } from "./events";
import type { Prefs } from "./prefs";
import { Session } from "./session";
import { SummaryBook } from "./summaries";
import { diffTranscripts, Transcript } from "./transcript";

export interface CoreOptions {
  adapters: Adapter[];
  bus: EventBus<CoreEvents>;
  /** sends to the app (the connection caps events, shared/limits.ts) */
  send: (m: RunnerToServer) => boolean;
  /** this runner process's summary epoch */
  epoch: string;
  prefs: Prefs;
  /** how often discovery looks for sessions started elsewhere */
  discoverMs?: number;
  /** how long an unwatched stored session's transcript stays in memory */
  evictMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

/** "~/x" and "~" as the home folder; the rest resolved to an absolute path. */
export function expandPath(p: string): string {
  const t = p.trim();
  if (t === "~") return homedir();
  if (t.startsWith("~/")) return resolve(homedir(), t.slice(2));
  return resolve(t);
}

const emptyState = (mode: LiveState["mode"] = "stored"): LiveState => ({ mode, status: "idle", requests: [], queue: [] });

export class SessionCore {
  readonly sessions = new Map<string, Session>();
  /** sessions at least one browser has subscribed to (since the last connect) */
  readonly watched = new Set<string>();
  readonly book: SummaryBook;
  /** the last seq of sessions no longer in memory: numbering goes on from there */
  private seqs = new Map<string, number>();
  private opening = new Map<string, Promise<Session>>();
  private evictTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private discoverTimer?: ReturnType<typeof setInterval>;
  private discovering?: Promise<void>;
  readonly log: (line: string) => void;
  readonly now: () => number;

  constructor(readonly o: CoreOptions) {
    this.log = o.log ?? ((l) => console.log(l));
    this.now = o.now ?? Date.now;
    this.book = new SummaryBook(o.epoch, (summary) => void o.send({ t: "summary", summary }), this.now);
    o.bus.on("unwatched", ({ sessionIds }) => sessionIds.forEach((id) => this.unwatch(id)));
    o.bus.on("disconnected", () => [...this.watched].forEach((id) => this.unwatch(id)));
    o.bus.on("connected", () => this.book.announce());
  }

  adapter(harness: HarnessId): Adapter {
    const a = this.o.adapters.find((x) => x.id === harness);
    if (!a) throw new Error(`This runner can't drive ${harness} sessions yet.`);
    return a;
  }

  // ---------------- discovery ----------------

  /** Starts looking for sessions started elsewhere (and does a first pass now). */
  startDiscovery() {
    void this.discover();
    this.discoverTimer = setInterval(() => void this.discover(), this.o.discoverMs ?? 10_000);
    this.discoverTimer.unref?.();
  }

  stop() {
    clearInterval(this.discoverTimer);
    for (const t of this.evictTimers.values()) clearTimeout(t);
    for (const s of this.sessions.values()) {
      s.unwatch?.();
      clearTimeout(s.idleTimer);
    }
  }

  /** One discovery pass (at most one at a time). */
  discover(): Promise<void> {
    this.discovering ??= (async () => {
      try {
        const since = this.now() - 3 * 24 * 60 * 60 * 1000;
        const found = (await Promise.all(this.o.adapters.map((a) => a.listSessions({ since }).catch(() => [] as SessionSummary[])))).flat();
        for (const f of found) {
          const s = this.sessions.get(f.id);
          if (s && !s.live && !s.childRunning) s.summary = { ...f, mode: s.state.mode, status: s.state.status };
        }
        this.book.refresh(
          found,
          (id) => this.owned(id),
          (id) => this.watched.has(id),
        );
      } catch (e: any) {
        this.log(`discovery failed: ${e?.message ?? e}`);
      } finally {
        this.discovering = undefined;
      }
    })();
    return this.discovering;
  }

  /** Rows the core keeps current itself: live sessions and running subagents. */
  private owned(id: string) {
    const s = this.sessions.get(id);
    return !!s && (s.live || s.childRunning);
  }

  async listProjects(): Promise<ProjectInfo[]> {
    const by = new Map<string, ProjectInfo>();
    for (const a of this.o.adapters)
      for (const p of await a.listProjects().catch(() => [] as ProjectInfo[])) {
        const had = by.get(p.path);
        by.set(p.path, had ? { ...had, harnesses: [...new Set([...had.harnesses, ...p.harnesses])], updatedAt: Math.max(had.updatedAt, p.updatedAt), sessions: had.sessions + p.sessions } : p);
      }
    return [...by.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Session rows with what the core knows live laid over what the stores say. */
  private overlay(list: SessionSummary[]): SessionSummary[] {
    return list.map((s) => {
      const live = this.sessions.get(s.id);
      return live && (live.live || live.childRunning) ? live.summary : s;
    });
  }

  async listSessions(args: { projectPath?: string; parentSessionId?: string; query?: string; limit?: number }): Promise<{ sessions: SessionSummary[]; epoch?: string; seq?: number }> {
    const limit = Math.max(1, Math.min(args.limit ?? 500, 2000));
    if (args.parentSessionId) {
      const parent = await this.open(args.parentSessionId);
      const stored = await this.adapter(parent.summary.harness).listSubagents(parent.summary.nativeId, parent.summary.projectPath).catch(() => []);
      const byId = new Map(this.overlay(stored).map((s) => [s.id, s]));
      for (const s of this.sessions.values()) if (s.summary.parentSessionId === parent.id) byId.set(s.id, s.summary);
      return { sessions: [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit) };
    }
    if (args.projectPath === undefined && !args.query?.trim()) return this.book.all();
    const all = (await Promise.all(this.o.adapters.map((a) => a.listSessions(args.projectPath ? { projectPath: expandPath(args.projectPath) } : {}).catch(() => [] as SessionSummary[])))).flat();
    // Live sessions not yet in any store (a new session before its first message).
    const byId = new Map(this.overlay(all).map((s) => [s.id, s]));
    for (const s of this.sessions.values())
      if (s.live && !s.summary.parentSessionId && (!args.projectPath || s.summary.projectPath === expandPath(args.projectPath))) byId.set(s.id, s.summary);
    const q = args.query?.trim().toLowerCase();
    const rows = [...byId.values()].filter((s) => !q || s.title.toLowerCase().includes(q));
    return { sessions: rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, q ? Math.min(limit, 100) : limit) };
  }

  // ---------------- sessions ----------------

  /** The session object for an id, made from what the store says when it isn't open yet. */
  open(id: string): Promise<Session> {
    const have = this.sessions.get(id);
    if (have) return Promise.resolve(have);
    let p = this.opening.get(id);
    if (!p) {
      p = this.make(id).finally(() => this.opening.delete(id));
      this.opening.set(id, p);
    }
    return p;
  }

  private async make(id: string): Promise<Session> {
    const parsed = parseSessionId(id);
    if (!parsed) throw new Error("That isn't a session id.");
    const a = this.adapter(parsed.harness);
    const row = this.book.get(id) ?? (await a.sessionInfo(parsed.nativeId).catch(() => undefined));
    if (!row) throw new Error("That session isn't on this runner any more.");
    const prefs = this.o.prefs.get(id);
    const defaults = await a.defaults(row.projectPath).catch(() => ({}) as StartOpts);
    const state: LiveState = { ...emptyState(), ...pick(defaults), ...pick(prefs) };
    // Another open() may have made it meanwhile (a live child appearing).
    const raced = this.sessions.get(id);
    if (raced) return raced;
    const s = this.add(new Session({ ...row, mode: "stored", status: "idle" }, state, a.capabilities, this.out, this.seqs.get(id) ?? 0));
    return s;
  }

  /** Registers a session object (new, opened, or a live subagent). */
  add(s: Session): Session {
    this.sessions.set(s.id, s);
    this.seqs.delete(s.id);
    return s;
  }

  /** Makes a session object for a brand new session (newSession). */
  create(harness: HarnessId, nativeId: string, projectPath: string, opts: StartOpts): Session {
    const a = this.adapter(harness);
    const id = sessionId(harness, nativeId);
    const summary: SessionSummary = { id, harness, nativeId, projectPath, title: "New session", mode: "live", status: "idle", updatedAt: this.now() };
    const s = this.add(new Session(summary, { ...emptyState("live"), ...pick(opts) }, a.capabilities, this.out));
    s.transcript = new Transcript();
    s.fresh = true;
    this.o.prefs.set(id, { projectPath, ...pick(opts) });
    return s;
  }

  /** Validates a folder for a new session. */
  folder(path: string): string {
    if (!path?.trim()) throw new Error("Pick a folder for the session.");
    const abs = expandPath(path);
    if (!existsSync(abs)) throw new Error(`There's no folder ${abs} on this runner.`);
    if (!statSync(abs).isDirectory()) throw new Error(`${abs} isn't a folder.`);
    return abs;
  }

  /** The transcript, read from the store the first time. */
  load(s: Session): Promise<Transcript> {
    if (s.transcript) return Promise.resolve(s.transcript);
    s.loading ??= this.adapter(s.summary.harness)
      .readHistory(s.summary.nativeId, s.summary.projectPath)
      .then((msgs) => {
        // A live driver may have created it meanwhile (send right after open).
        s.transcript ??= new Transcript(msgs);
        return s.transcript;
      })
      .finally(() => (s.loading = undefined));
    return s.loading;
  }

  /** Sends a numbered event to the app when someone watches the session. */
  readonly out = (sessionId: string, seq: number, event: SessionEvent) => {
    if (this.watched.has(sessionId)) this.o.send({ t: "event", sessionId, seq, event });
  };

  // ---------------- watching ----------------

  async subscribe(id: string, limit = TRANSCRIPT_PAGE): Promise<SessionSnapshot> {
    // Watched from the start, so no event between the snapshot and the answer is lost.
    this.watched.add(id);
    this.cancelEvict(id);
    try {
      const s = await this.open(id);
      await this.load(s);
      if (!s.live && !s.childRunning) this.tail(s);
      return s.snapshot(Math.max(1, Math.min(limit | 0 || TRANSCRIPT_PAGE, 200)));
    } catch (e) {
      // The relay drops the route of a failed subscribe and says `unwatched` only if it ever
      // succeeded: forget it here.
      this.unwatch(id);
      throw e;
    }
  }

  /** Tails a stored session's store while it is watched (SPEC §6 watchHistory). */
  tail(s: Session) {
    if (s.unwatch || !this.watched.has(s.id)) return;
    s.unwatch = this.adapter(s.summary.harness).watchHistory(s.summary.nativeId, s.summary.projectPath, (msgs) => {
      if (s.live || s.childRunning || !s.transcript) return;
      for (const e of diffTranscripts(s.transcript.messages, msgs)) s.apply(e);
      this.touch(s);
    });
  }

  /** Nobody watches it any more: stop tailing, and drop it from memory after a while. */
  unwatch(id: string) {
    this.watched.delete(id);
    const s = this.sessions.get(id);
    if (!s) return;
    s.unwatch?.();
    s.unwatch = undefined;
    this.scheduleEvict(s);
  }

  scheduleEvict(s: Session) {
    if (s.live || s.childRunning || this.watched.has(s.id)) return;
    this.cancelEvict(s.id);
    const t = setTimeout(() => {
      this.evictTimers.delete(s.id);
      if (s.live || s.childRunning || this.watched.has(s.id) || this.sessions.get(s.id) !== s) return;
      this.sessions.delete(s.id);
      this.seqs.set(s.id, s.seq);
      // A new session that never got a message has nothing in any store: it's gone.
      if (s.fresh) this.book.remove([s.id]);
    }, this.o.evictMs ?? 60_000);
    t.unref?.();
    this.evictTimers.set(s.id, t);
  }

  private cancelEvict(id: string) {
    clearTimeout(this.evictTimers.get(id));
    this.evictTimers.delete(id);
  }

  history(s: Session, before: string, limit = TRANSCRIPT_PAGE) {
    if (!s.transcript) throw new Error("Open the session first.");
    return s.transcript.before(before, Math.max(1, Math.min(limit | 0 || TRANSCRIPT_PAGE, 200)));
  }

  fullPart(s: Session, msgId: string, part: number, offset = 0): PartChunk {
    const m: Msg | undefined = s.transcript?.get(msgId);
    const p = m?.parts[part];
    if (!p) throw new Error("That part is no longer in the transcript.");
    return partChunk(p, offset);
  }

  /** The session's row changed (status, mode, title, activity): the sidebar hears. */
  touch(s: Session, patch: Partial<SessionSummary> = {}) {
    s.summary = { ...s.summary, ...patch, mode: s.state.mode, status: s.state.status };
    if (s.live || s.childRunning || this.book.get(s.id) || this.watched.has(s.id)) this.book.upsert([s.summary]);
  }
}

/** The settings fields of prefs or defaults, without empty ones. */
function pick(o: StartOpts): StartOpts {
  const out: StartOpts = {};
  if (o.model) out.model = o.model;
  if (o.effort) out.effort = o.effort;
  if (o.permissionMode) out.permissionMode = o.permissionMode;
  return out;
}
