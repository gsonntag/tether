import { isAccountSource, isSubscriptionSource, type BillingSource } from "../../../shared/credentials";
// The session core (SPEC §3, §4, §5): the session registry, stored and live modes, event
// numbering, snapshots and pages, and the summary list. Driving a live session (drivers, sinks,
// idle close) is in live.ts; the rpc ops that call into this are in sessionOps.ts.
//
// Sessions are opened lazily: a Session object exists while someone has it open, while it is live,
// or while a subagent of it runs. Its transcript is read from the harness's store on first open
// (never kept on disk by Tether) and tailed while it's stored and watched.

import { needsHarnessLogin } from "../../../shared/harnessLogin";
import { nextScheduled, unscheduled } from "../../../shared/schedule";
import { watchingSummary } from "../../../shared/watchers";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { CostLedger } from "../costs";
import type { SessionPrefs, WorktreeRecord } from "../config";
import { partChunk, type PartChunk } from "../../../shared/limits";
import type { ArchiveWorktree, FolderCheck, RunnerToServer } from "../../../shared/protocol";
import { parseSessionId, sessionId } from "../../../shared/ids";
import { mergePlan } from "../../../shared/labels";
import type { HarnessId, LiveState, Msg, PlanUsage, ProjectInfo, Request, SessionEvent, SessionSnapshot, SessionSummary } from "../../../shared/transcript";
import { AGENT_NAMES, HARNESS_LABELS, TRANSCRIPT_PAGE, UNKNOWN_BILLING } from "../../../shared/transcript";
import type { Adapter, StartOpts } from "./adapter";
import type { EventBus } from "./bus";
import type { CoreEvents } from "./events";
import type { Prefs } from "./prefs";
import { NoticeStore, pruneOverlay, settleStopped, withOverlay } from "./notices";
import { MessageQueue } from "./queue";
import { Session } from "./session";
import { PIN_SNAPSHOT_MS, PinnedRows } from "./pinnedRows";
import { RECENT_MS, SummaryBook } from "./summaries";
import { diffTranscripts, Transcript } from "./transcript";

export interface CoreOptions {
  costs?: CostLedger;
  adapters: Adapter[];
  bus: EventBus<CoreEvents>;
  /** sends to the app (the connection caps events, shared/limits.ts) */
  send: (m: RunnerToServer) => boolean;
  /** this runner process's summary epoch */
  epoch: string;
  prefs: Prefs;
  /** Tether's own notices, kept across eviction and restarts (in memory only when absent) */
  notices?: NoticeStore;
  /** how often discovery looks for sessions started elsewhere */
  discoverMs?: number;
  /** how long an unwatched stored session's transcript stays in memory */
  evictMs?: number;
  /** TETHER_HIDE_PROJECTS: folders left out of the lists (hidePattern) */
  hideProjects?: string;
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * "~/x" and "~" as the home folder; a relative path against the home folder too (not wherever the
 * runner was started); the rest resolved to an absolute path.
 */
export function expandPath(p: string): string {
  const t = p.trim();
  if (t === "~") return homedir();
  if (t.startsWith("~/")) return resolve(homedir(), t.slice(2));
  return resolve(homedir(), t);
}

const noPermission = (abs: string) => `No permission to create ${abs}.`;
const notAFolder = (p: string) => `${p} isn't a folder.`;

/**
 * Whether a path is a folder, or could be made into one: the nearest thing that exists on the way up
 * decides. Only reads. TETHER_HIDE_PROJECTS doesn't come into it: hiding only touches the lists.
 */
export function checkFolder(path: string): FolderCheck {
  const abs = expandPath(path);
  const t = path.trim();
  const rooted = t.startsWith("/") || t === "~" || t.startsWith("~/");
  const error = (error: string): FolderCheck => ({ path: abs, state: "error", error });
  for (let p = abs; ; p = dirname(p)) {
    try {
      if (!statSync(p).isDirectory()) return error(notAFolder(p));
      if (p === abs) return { path: abs, state: "exists" };
      if (!rooted) return { path: abs, state: "relative", error: "Use a full path, like ~/code/app." };
      accessSync(p, constants.W_OK | constants.X_OK);
      return { path: abs, state: "missing" };
    } catch (e: any) {
      if (e?.code === "EACCES" || e?.code === "EPERM" || e?.code === "EROFS") return error(noPermission(abs));
      if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") return error(`Can't use ${abs}: ${e?.message ?? e}`);
      // A link to nothing: stat can't see it, but nothing can be made through it.
      if (e.code === "ENOENT" && lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) return error(notAFolder(p));
    }
  }
}

/** A comma-separated list of path globs as one pattern (`*`: anything, `/` too); none: undefined. */
export function hidePattern(globs = ""): RegExp | undefined {
  const list = globs.split(",").map((g) => g.trim()).filter(Boolean);
  if (!list.length) return undefined;
  const source = list.map((g) => g.split(/\*+/).map((lit) => lit.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*"));
  return new RegExp(`^(?:${source.join("|")})$`, "s");
}

/** A fork's link to where it was made from (SPEC §16) and a side chat's to its session (§16a), kept with its settings. */
const forked = (p: SessionPrefs) => ({ ...(p.forkedFrom ? { forkedFrom: p.forkedFrom } : {}), ...(p.sideOf ? { sideOf: p.sideOf } : {}) });

const emptyState = (mode: LiveState["mode"] = "stored"): LiveState => ({ mode, status: "idle", requests: [], queue: [] });

/** An archive's cause as logged and kept: a short label, printable, whatever a caller passed. */
export function archiveCause(by: unknown): string {
  const t = typeof by === "string" ? by.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 120) : "";
  return t || "unknown";
}

export class SessionCore {
  readonly sessions = new Map<string, Session>();
  /** each harness's latest plan limits report: account-wide, so not any one session's */
  private plans = new Map<string, PlanUsage>();
  /** sessions at least one browser has subscribed to (since the last connect) */
  readonly watched = new Set<string>();
  readonly book: SummaryBook;
  private pinnedRows: PinnedRows;
  /** the last seq of sessions no longer in memory: numbering goes on from there */
  private seqs = new Map<string, number>();
  private opening = new Map<string, Promise<Session>>();
  private evictTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private discoverTimer?: ReturnType<typeof setInterval>;
  private discovering?: Promise<void>;
  readonly log: (line: string) => void;
  readonly now: () => number;
  readonly notices: NoticeStore;
  private hide?: RegExp;
  /** a session's open requests (the request desk sets this, core/requests.ts) */
  requestsFor: (sessionId: string) => Request[] = () => [];

  constructor(readonly o: CoreOptions) {
    this.notices = o.notices ?? new NoticeStore();
    this.log = o.log ?? ((l) => console.log(l));
    this.now = o.now ?? Date.now;
    this.hide = hidePattern(o.hideProjects);
    this.book = new SummaryBook(o.epoch, (summary) => void o.send({ t: "summary", summary }), this.now);
    this.pinnedRows = new PinnedRows(o.adapters, (id) => o.prefs.get(id).projectPath, (id) => this.pinSnapshot(id), this.now);
    o.bus.on("unwatched", ({ sessionIds }) => sessionIds.forEach((id) => this.unwatch(id)));
    o.bus.on("disconnected", () => [...this.watched].forEach((id) => this.unwatch(id)));
    this.book.hidden = (id) => this.replaced(id);
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
    this.notices.flush();
    for (const t of this.evictTimers.values()) clearTimeout(t);
    for (const s of this.sessions.values()) {
      s.unwatch?.();
      clearTimeout(s.idleTimer);
      clearTimeout(s.retryTimer);
    }
  }

  /** One discovery pass (at most one at a time). */
  discover(): Promise<void> {
    this.discovering ??= (async () => {
      try {
        const since = this.now() - 3 * 24 * 60 * 60 * 1000;
        const found = (await Promise.all(this.o.adapters.map((a) => a.listSessions({ since }).catch(() => [] as SessionSummary[])))).flat();
        // Pinned sessions are listed however old: the ones too old for that pass (pinnedRows.ts).
        const seen = new Set(found.map((f) => f.id));
        found.push(...(await this.pinnedRows.rows(this.o.prefs.pinned().filter((id) => !seen.has(id)))));
        // A pinned session's row as last seen, for when its harness can't find it.
        for (const f of found) {
          const p = this.o.prefs.get(f.id);
          if (!p.pinned || f.missing) continue;
          // runner.json is written for a new title or folder, but for activity at most hourly.
          const r = p.pinnedRow;
          if (!r || r.title !== f.title || r.projectPath !== f.projectPath || Math.abs(f.updatedAt - r.updatedAt) >= PIN_SNAPSHOT_MS)
            this.o.prefs.set(f.id, { pinnedRow: { title: f.title, projectPath: f.projectPath, updatedAt: f.updatedAt } });
        }
        for (const f of found) {
          const s = this.sessions.get(f.id);
          if (s && !s.live && !s.childRunning && !f.missing) {
            const prefs = this.o.prefs.get(f.id);
            s.summary = { ...f, ...(prefs.title ? { title: prefs.title } : {}), ...(prefs.archived ? { archived: true } : {}), ...(prefs.pinned ? { pinned: prefs.pinned } : {}), ...forked(prefs), ...worktreeOf(prefs), ...(s.state.billing ? { billing: s.state.billing } : {}), mode: s.state.mode, status: s.state.status, ...(s.state.requests.length ? { requests: s.state.requests.length } : {}) };
          }
        }
        this.book.refresh(
          found.filter((f) => this.shown(f)).map((f) => {
            const p = this.o.prefs.get(f.id);
            return { ...f, ...(p.archived ? { archived: true } : {}), ...(p.pinned ? { pinned: p.pinned } : {}), ...forked(p), ...worktreeOf(p) };
          }),
          (id) => this.owned(id),
          // Keep a login failure in Home even if the harness has not created the session record.
          (id) => this.watched.has(id) || !!this.o.prefs.get(id).pinned || this.pendingHarnessLogin(id),
        );
      } catch (e: any) {
        this.log(`discovery failed: ${e?.message ?? e}`);
      } finally {
        this.discovering = undefined;
      }
    })();
    return this.discovering;
  }

  private pendingHarnessLogin(id: string) {
    const p = this.o.prefs.get(id);
    return p.unread === "failed" && !!p.failure && needsHarnessLogin(p.failure);
  }

  /** Rows the core keeps current itself: live sessions, running subagents, and sessions waiting on a person. */
  private owned(id: string) {
    const s = this.sessions.get(id);
    return !!s && (s.live || !!s.retry || s.childRunning || s.state.requests.length > 0 || s.state.queue.length > 0 || s.state.mode === "terminal" || !!s.state.terminal);
  }

  /** A session that went on under another id, or a thread that may yet: one row for the conversation. */
  private replaced(id: string) {
    const p = this.o.prefs.get(id);
    return !!p.carrying || !!(p.carried && p.movedTo);
  }

  /** A folder TETHER_HIDE_PROJECTS names. */
  hidden(path: string): boolean {
    return !!this.hide?.test(path);
  }

  /** Left out of the lists: a folder TETHER_HIDE_PROJECTS names, unless the session is open or live right now. */
  private shown(row: SessionSummary) {
    if (this.replaced(row.id)) return false;
    if (!this.hide?.test(row.projectPath)) return true;
    const s = this.sessions.get(row.id);
    return this.watched.has(row.id) || (!!s && this.held(s));
  }

  async listProjects(): Promise<ProjectInfo[]> {
    const by = new Map<string, ProjectInfo>();
    for (const a of this.o.adapters)
      for (const p of await a.listProjects().catch(() => [] as ProjectInfo[])) {
        const had = by.get(p.path);
        by.set(p.path, had ? { ...had, harnesses: [...new Set([...had.harnesses, ...p.harnesses])], updatedAt: Math.max(had.updatedAt, p.updatedAt), sessions: had.sessions + p.sessions } : p);
      }
    return [...by.values()].filter((p) => !this.hide?.test(p.path)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Session rows with what the core knows live laid over what the stores say. */
  private overlay(list: SessionSummary[]): SessionSummary[] {
    return list.map((s) => {
      const row = this.owned(s.id) ? this.sessions.get(s.id)!.summary : s;
      const prefs = this.o.prefs.get(row.id);
      return { ...row, ...(prefs.title ? { title: prefs.title } : {}), ...(prefs.archived ? { archived: true } : { archived: undefined }), pinned: prefs.pinned || undefined, ...forked(prefs), ...worktreeOf(prefs) };
    });
  }

  /** `archived`: only the archived ones. `all`: every stored one, of any age, archived or not. */
  async listSessions(args: { projectPath?: string; parentSessionId?: string; sideOf?: string; query?: string; limit?: number; archived?: boolean; all?: boolean }): Promise<{ sessions: SessionSummary[]; epoch?: string; seq?: number }> {
    const limit = Math.max(1, Math.min(args.limit ?? 500, 2000));
    if (args.sideOf) {
      // A session's side chats (SPEC §16a), closed ones too: by the prefs' index, never a folder scan.
      const rows: SessionSummary[] = [];
      for (const id of this.o.prefs.sideChatsOf(args.sideOf)) {
        const archived = this.o.prefs.get(id).archived ? { archived: true } : { archived: undefined };
        const s = this.sessions.get(id);
        if (s) {
          rows.push({ ...s.summary, ...archived });
          continue;
        }
        const parsed = parseSessionId(id);
        const known = this.book.get(id) ?? (parsed ? await this.adapter(parsed.harness).sessionInfo(parsed.nativeId).catch(() => undefined) : undefined);
        if (known) rows.push({ ...this.overlay([known])[0]!, ...archived });
      }
      return { sessions: rows.filter((r) => r.sideOf === args.sideOf).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit) };
    }
    if (args.parentSessionId) {
      const parent = await this.open(args.parentSessionId);
      const stored = await this.adapter(parent.summary.harness).listSubagents(parent.summary.nativeId, parent.summary.projectPath).catch(() => []);
      const byId = new Map(this.overlay(stored).map((s) => [s.id, s]));
      for (const s of this.sessions.values()) if (s.summary.parentSessionId === parent.id) byId.set(s.id, s.summary);
      return { sessions: [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit) };
    }
    if (args.projectPath === undefined && !args.query?.trim() && !args.archived && !args.all) return this.book.all();
    // A main checkout's list has its worktrees' sessions too (SPEC §4: the web lists them under it): each worktree recorded with it as its repo.
    const folders: (string | undefined)[] = args.projectPath ? this.withWorktrees(expandPath(args.projectPath)) : [undefined];
    const all = (await Promise.all(folders.flatMap((f) => this.o.adapters.map((a) => a.listSessions(f ? { projectPath: f } : {}).catch(() => [] as SessionSummary[]))))).flat();
    // Live sessions not yet in any store (a new session before its first message).
    const byId = new Map(this.overlay(all).map((s) => [s.id, s]));
    for (const s of this.sessions.values())
      if (s.live && !s.summary.parentSessionId && (!args.projectPath || folders.includes(s.summary.projectPath))) byId.set(s.id, s.summary);
    const q = args.query?.trim().toLowerCase();
    // Side chats (SPEC §16a) are listed under their session only.
    const rows = [...byId.values()].filter((s) => this.shown(s) && !s.sideOf && (args.all ? !s.parentSessionId : args.archived ? !!s.archived && !s.parentSessionId : !s.archived || !!q) && (!q || s.title.toLowerCase().includes(q)));
    return { sessions: rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, q ? Math.min(limit, 100) : limit) };
  }

  /** `folder` and the worktrees runner.json records with it as their main checkout. */
  private withWorktrees(folder: string): string[] {
    const main = resolve(folder);
    const trees = this.o.prefs.ids((p) => !!p.worktree?.repo && resolve(p.worktree.repo) === main).map((id) => this.o.prefs.get(id).worktree!.path);
    return [...new Set([folder, ...trees.filter((t) => resolve(t) !== main)])];
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
    // A missing pinned row is only what was saved: not a session to open.
    const listed = this.book.get(id);
    const known = (listed && !listed.missing ? listed : undefined) ?? (await a.sessionInfo(parsed.nativeId).catch(() => undefined));
    const prefs = this.o.prefs.get(id);
    // A new session that never got a message: nothing of it is stored (a harness may still know its
    // id). Prefs alone don't say so: a stored session whose store was deleted stays gone.
    const blank = !!prefs.projectPath && (!!prefs.movedTo || (!!prefs.blank && (!known || !!(await a.noStore?.(parsed.nativeId).catch(() => true)))));
    const row: SessionSummary | undefined = known ?? (blank ? { id, harness: parsed.harness, nativeId: parsed.nativeId, projectPath: prefs.projectPath!, title: "New session", mode: "stored", status: "idle", updatedAt: prefs.at ?? this.now() } : undefined);
    if (!row) throw new Error("That session isn't on this runner any more.");
    const defaults = await a.defaults(row.projectPath, parsed.nativeId).catch(() => ({}) as StartOpts);
    const source = prefs.source ?? a.billing?.recorded?.(parsed.nativeId, row.projectPath);
    const keySession = source && !isSubscriptionSource(source) && !row.parentSessionId && !prefs.sideOf;
    const state: LiveState = { ...emptyState(), ...(row.billing ? { billing: row.billing } : {}), ...a.unset, ...pick(defaults), ...chosenOf(a, prefs), ...MessageQueue.saved(prefs), ...(prefs.fallbackChain ? { fallbackChain: prefs.fallbackChain } : {}), ...(prefs.movedTo ? { continuedIn: prefs.movedTo } : {}), ...(prefs.carried ? { carried: true } : {}), ...(prefs.nextBilling ? { nextBilling: prefs.nextBilling } : {}), ...(prefs.nextDeployment ? { nextDeployment: prefs.nextDeployment } : {}), ...(prefs.nextSource && prefs.nextModel ? { nextModel: prefs.nextModel } : {}), ...(prefs.sourceSwitchFailed ? { sourceSwitchFailed: true } : {}), ...(prefs.canText ? { canText: true } : {}), ...(keySession ? { retryThrottled: prefs.retryThrottled === true } : {}), ...(prefs.lastKey ? { lastKey: prefs.lastKey } : {}), ...(prefs.setup ? { setup: "failed" as const } : {}), requests: this.requestsFor(id) };
    // Another open() may have made it meanwhile (a live child appearing).
    const raced = this.sessions.get(id);
    if (raced) return raced;
    const s = this.add(new Session({ ...row, ...(prefs.title ? { title: prefs.title } : {}), ...(prefs.archived ? { archived: true } : {}), ...(prefs.pinned ? { pinned: prefs.pinned } : {}), ...forked(prefs), ...worktreeOf(prefs), mode: "stored", status: "idle" }, state, a.capabilities, this.out, this.seqs.get(id) ?? 0));
    if (blank) {
      // Back as new: the first message starts it (live.ts current). No row until something happens.
      s.transcript = new Transcript(withOverlay([], s.overlay));
      s.fresh = s.rebuilt = true;
      s.movedTo = prefs.movedTo;
    } else if (prefs.blank) this.o.prefs.set(id, { blank: undefined });
    // Opened by an op that doesn't subscribe (send, a setting, a page): it leaves memory again
    // unless it's watched or live by then (the eviction checks when it fires).
    this.scheduleEvict(s);
    return s;
  }

  /** Registers a session object (new, opened, or a live subagent). */
  add(s: Session): Session {
    if (this.o.costs && (this.o.costs.has(s.id) || this.o.prefs.get(s.id).metered)) {
      s.state = { ...s.state, cost: this.o.costs.get(s.id) };
      s.summary = { ...s.summary, cost: s.state.cost };
    }
    const plan = this.planFor(s.summary.harness, this.o.prefs.get(s.id).source);
    if (plan && !s.summary.parentSessionId) s.state = { ...s.state, plan };
    if (!s.overlay.length) s.overlay = this.notices.get(s.id);
    s.noticeAdded = (n) => this.notices.add(s.id, n);
    this.sessions.set(s.id, s);
    this.seqs.delete(s.id);
    return s;
  }

  /** Makes a session object for a brand new session (newSession). */
  create(harness: HarnessId, nativeId: string, projectPath: string, opts: StartOpts): Session {
    const a = this.adapter(harness);
    const id = sessionId(harness, nativeId);
    const summary: SessionSummary = { id, harness, nativeId, projectPath, title: "New session", mode: "live", status: "idle", updatedAt: this.now() };
    const s = this.add(new Session(summary, { ...emptyState("live"), ...a.unset, ...chosenOf(a, opts) }, a.capabilities, this.out));
    s.transcript = new Transcript();
    s.fresh = true;
    this.o.prefs.set(id, { projectPath, blank: true, ...chosenOf(a, opts) });
    return s;
  }

  /** A new session that never got a message leaves memory and the lists; opening its id brings it back (make). */
  dropFresh(s: Session) {
    this.book.remove([s.id]);
    this.sessions.delete(s.id);
    this.seqs.set(s.id, s.seq);
  }

  /** Whether a new session's store exists: its id is taken, so it can only resume. */
  async hasStore(s: Session) {
    const a = this.adapter(s.summary.harness);
    if (!(await a.sessionInfo(s.summary.nativeId, s.summary.projectPath).catch(() => undefined))) return false;
    return !(await a.noStore?.(s.summary.nativeId).catch(() => true));
  }

  /** Validates a folder for a new session. */
  folder(path: string, create = false): string {
    if (!path?.trim()) throw new Error("Pick a folder for the session.");
    if (!create) {
      const abs = expandPath(path);
      if (!existsSync(abs)) throw new Error(`There's no folder ${abs} on this runner.`);
      if (!statSync(abs).isDirectory()) throw new Error(notAFolder(abs));
      return abs;
    }
    const { path: abs, state, error } = checkFolder(path);
    if (state === "exists") return abs;
    if (state !== "missing") throw new Error(error);
    try {
      mkdirSync(abs, { recursive: true });
    } catch (e: any) {
      if (e?.code === "EACCES" || e?.code === "EPERM" || e?.code === "EROFS") throw new Error(noPermission(abs));
      if (e?.code === "EEXIST" || e?.code === "ENOTDIR") throw new Error(notAFolder(abs));
      throw new Error(`Can't create ${abs}: ${e?.message ?? e}`);
    }
    return abs;
  }

  /** The transcript, read from the store the first time. */
  load(s: Session): Promise<Transcript> {
    if (s.transcript) return Promise.resolve(s.transcript);
    s.loading ??= this.adapter(s.summary.harness)
      .readHistory(s.summary.nativeId, s.summary.projectPath)
      .then((msgs) => {
        // A turn that was running when the runner (or the harness) stopped: say so where it ended.
        // Anchored to the end of that turn: what an orphaned process still writes lands above it.
        // A harness that keeps turns going without the runner (capabilities.persistent) wasn't cut off.
        const p = this.o.prefs.get(s.id);
        // (Not during the quiet wait after a restart: its turn may yet be continued.)
        if (!s.live && !s.sending && !s.capabilities.persistent && (p.running || p.cutOff) && !p.restartWait) {
          const prompt = [...msgs].reverse().find((m) => m.role === "user" && !m.origin);
          const agent = AGENT_NAMES[s.summary.harness];
          const text = s.state.requests.length
            ? `The runner restarted while ${agent} was waiting for you. Answer below and ${agent} picks up from there.`
            : `This turn stopped because the runner restarted or ${HARNESS_LABELS[s.summary.harness]} exited. Send a message to continue.`;
          const n = { turnOf: prompt?.id, msg: { id: `n-cut-${s.id}-${prompt?.id ?? "x"}`, role: "notice" as const, level: "warning" as const, ts: msgs.at(-1)?.ts ?? this.now(), parts: [{ type: "text" as const, text }] } };
          if (!s.overlay.some((o) => o.msg.id === n.msg.id)) {
            s.overlay.push(n);
            this.notices.add(s.id, n);
          }
          this.o.prefs.set(s.id, { running: undefined, cutOff: undefined });
        }
        this.prune(s, msgs);
        // A live driver may have created it meanwhile (send right after open).
        s.transcript ??= new Transcript(settleStopped(withOverlay(msgs, s.overlay)));
        void this.readPlan(s);
        return this.storedContext(s).then(() => s.transcript!);
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
      const had = !!s.transcript;
      await this.load(s);
      // In the terminal while nobody watched: the TUI wrote to the store meanwhile.
      if (had && !s.unwatch && s.state.mode === "terminal") await this.syncFromStore(s);
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
      this.prune(s, msgs);
      for (const e of diffTranscripts(s.transcript.messages, settleStopped(withOverlay(msgs, s.overlay)))) {
        const out = s.apply(e);
        // New messages from the store are news too (a TUI's turn, in terminal mode).
        if (out?.type === "msg" && out.isNew) this.o.bus.emit("message", { sessionId: s.id, msg: out.msg });
      }
      this.touch(s);
      void this.storedContext(s);
    });
  }

  private planScope(harness: HarnessId, source?: BillingSource) {
    return isAccountSource(source) ? `${harness}:${source}` : harness;
  }

  planFor(harness: HarnessId, source?: BillingSource) {
    return this.plans.get(this.planScope(harness, source));
  }

  /** The account's plan limits, the latest report, on all its sessions. */
  notePlan(harness: HarnessId, report: PlanUsage, source?: BillingSource) {
    const scope = this.planScope(harness, source);
    const plan = mergePlan(this.plans.get(scope), report);
    this.plans.set(scope, plan);
    for (const s of this.sessions.values()) {
      if (s.summary.harness === harness && !s.summary.parentSessionId && this.planScope(harness, this.o.prefs.get(s.id).source) === scope) s.setState({ plan });
    }
  }

  private async readPlan(s: Session) {
    if (!s.summary.parentSessionId) await this.refreshPlan(s.summary.harness);
  }

  /** What the harness can say of its plan limits now, on all its sessions. */
  async refreshPlan(harness: HarnessId) {
    const plan = await this.adapter(harness).planUsage?.().catch(() => undefined);
    if (plan) this.notePlan(harness, plan);
    return this.plans.get(harness);
  }

  /** The context and billing as they're stored, when no driver reports them. Main sessions only. */
  private async storedContext(s: Session) {
    if (s.live || s.fresh || s.summary.parentSessionId) return;
    const a = this.adapter(s.summary.harness);
    const [context, billing] = await Promise.all([
      a.storedContext?.(s.summary.nativeId, s.summary.projectPath).catch(() => undefined),
      a.storedBilling?.(s.summary.nativeId, s.summary.projectPath).catch(() => UNKNOWN_BILLING),
    ]);
    if (!s.live) { s.setState({ context, billing }); this.touch(s); }
  }

  /** Drops notices whose anchor the store no longer has (notices.ts pruneOverlay). */
  private prune(s: Session, store: Msg[]) {
    const kept = pruneOverlay(store, s.overlay);
    if (kept.length === s.overlay.length) return;
    s.overlay = kept;
    this.notices.set(s.id, kept);
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
    if (this.held(s)) return;
    this.cancelEvict(s.id);
    const t = setTimeout(() => {
      this.evictTimers.delete(s.id);
      if (this.held(s) || this.sessions.get(s.id) !== s) return;
      // An unused session normally vanishes. A login failure is actionable from Home.
      if (s.fresh && !this.pendingHarnessLogin(s.id)) return this.dropFresh(s);
      this.sessions.delete(s.id);
      this.seqs.set(s.id, s.seq);
    }, this.o.evictMs ?? 60_000);
    t.unref?.();
    this.evictTimers.set(s.id, t);
  }

  /**
   * Stays in memory while something that will hold it gets there (a TUI starting): evicted meanwhile,
   * that something would carry on with an object nothing else can find.
   */
  pin(s: Session) {
    s.pins++;
  }

  /** Pinned no more: evicted as usual if nothing holds it now (an eviction due meanwhile was skipped). */
  unpin(s: Session) {
    s.pins--;
    this.scheduleEvict(s);
  }

  /** Kept in memory: live, starting or sending, running (a turn or a `!` command), waiting on a person, in a terminal, pinned, or watched. */
  private held(s: Session) {
    return s.live || !!s.retry || !!s.sending || !!s.starting || s.pins > 0 || s.childRunning || s.shellsRunning > 0 || s.state.requests.length > 0 || s.state.queue.length > 0 || s.state.mode === "terminal" || !!s.state.terminal || this.watched.has(s.id);
  }

  /**
   * Brings a loaded transcript up to date with the store (the TUI wrote to it while nobody
   * tailed it). Nothing to do when it isn't loaded: it's read fresh when someone opens it.
   */
  async syncFromStore(s: Session) {
    if (!s.transcript || s.live) return;
    const msgs = await this.adapter(s.summary.harness)
      .readHistory(s.summary.nativeId, s.summary.projectPath)
      .catch(() => undefined);
    if (!msgs || !s.transcript || s.live) return;
    this.prune(s, msgs);
    for (const e of diffTranscripts(s.transcript.messages, withOverlay(msgs, s.overlay))) s.apply(e);
    await this.storedContext(s);
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

  /**
   * Keeps a session out of Recent (or back in); archived sessions stay searchable. `worktree`
   * (archiving): "keep" marks its worktree record kept, saved with the archive (SPEC §4);
   * unarchiving drops the mark, so the next archive asks again. False: it already was.
   */
  async setArchived(s: Session, archived: boolean, worktree?: ArchiveWorktree, by: string = "unknown"): Promise<boolean> {
    const p = this.o.prefs.get(s.id);
    if ((p.archived === true) === archived) return false;
    const rec = p.worktree;
    const kept = rec && (archived ? worktree === "keep" : false);
    // What did it, in the log and with the session: an archive nobody remembers can be traced.
    const cause = archiveCause(by);
    this.log(`[archive] ${s.id} ${archived ? "archived" : "unarchived"} by ${cause}${p.pinned ? " (was pinned)" : ""}: ${JSON.stringify((s.summary.title ?? "").slice(0, 80))}`);
    // Archiving unpins: an archived session is out of every list.
    this.o.prefs.set(s.id, { projectPath: s.summary.projectPath, archived: archived || undefined, archiveCause: { archived, by: cause, at: this.now() }, ...(archived ? { pinned: undefined, pinnedRow: undefined } : {}), ...(rec && !!rec.keep !== !!kept ? { worktree: { ...rec, keep: kept || undefined } } : {}) });
    this.o.prefs.flush();
    this.touch(s);
    await this.discover();
    this.o.bus.emit("archived", { sessionId: s.id, archived, ...(archived && worktree ? { worktree } : {}) });
    return true;
  }

  /** Records the worktree a session works in as its own (New or Existing worktree, SPEC §4): saved at once. */
  setWorktree(s: Session, worktree: WorktreeRecord) {
    this.o.prefs.set(s.id, { projectPath: s.summary.projectPath, worktree });
    this.o.prefs.flush();
    this.touch(s);
  }

  /**
   * Puts a main session in the Sidebar's Pinned group, last (or takes it out); it is listed however old.
   * Pinning an archived session unarchives it: the person wants it in the list.
   */
  async setPinned(s: Session, pinned: boolean) {
    if (!!this.o.prefs.get(s.id).pinned === pinned) return;
    if (pinned && s.summary.parentSessionId) throw new Error("Only a main session can be pinned.");
    // A side chat (SPEC §16a) isn't in the lists: it shows under its session.
    if (pinned && (s.summary.sideOf || this.o.prefs.get(s.id).sideOf)) throw new Error("A side chat can't be pinned: it shows under its session.");
    // TETHER_HIDE_PROJECTS folders are never in the lists.
    if (pinned && this.hide?.test(s.summary.projectPath)) throw new Error("Sessions in this folder aren't listed, so they can't be pinned.");
    if (pinned && this.o.prefs.get(s.id).archived) await this.setArchived(s, false, undefined, "pin");
    // Unarchiving awaited a discovery: another pin call may have landed meanwhile.
    if (!!this.o.prefs.get(s.id).pinned === pinned) return;
    const { title, projectPath, updatedAt } = s.summary;
    this.o.prefs.set(s.id, { projectPath, pinned: pinned ? this.now() : undefined, pinnedRow: pinned ? { title, projectPath, updatedAt } : undefined });
    this.o.prefs.flush();
    this.touch(s);
    // At once, not at the next discovery (one may be under way, from before the pin).
    if (pinned) this.book.upsert([s.summary]);
    else if (!this.recent(s.summary) && !this.owned(s.id) && !this.watched.has(s.id)) this.book.remove([s.id]);
  }

  /** Unpins a session that may no longer exist (gone from its harness's store). */
  dropPin(id: string) {
    if (!this.o.prefs.get(id).pinned) return;
    this.o.prefs.set(id, { pinned: undefined, pinnedRow: undefined });
    this.o.prefs.flush();
    const s = this.sessions.get(id);
    if (s) this.touch(s);
    if (!this.owned(id) && !this.watched.has(id)) this.book.remove([id]);
  }

  /** Recent enough for Recent on its own (summaries.ts RECENT_MS), pinned or not. */
  private recent(row: SessionSummary) {
    return row.updatedAt >= this.now() - RECENT_MS;
  }

  /**
   * The rows the lists show, without those listed only because they are pinned: what the modules
   * see (tether_sessions, the worktrees' users), so a pin doesn't widen it.
   */
  listed(): SessionSummary[] {
    return this.book.list().filter((r) => !r.missing && (!r.pinned || this.recent(r) || this.owned(r.id) || this.watched.has(r.id)));
  }

  /** A pinned session's row from its pin (SessionPrefs.pinnedRow), for when nothing else has one. */
  private pinSnapshot(id: string): SessionSummary {
    const p = this.o.prefs.get(id);
    const parsed = parseSessionId(id) ?? { harness: "claude" as const, nativeId: id };
    const r = p.pinnedRow;
    return { id, harness: parsed.harness, nativeId: parsed.nativeId, projectPath: r?.projectPath ?? p.projectPath ?? "", title: r?.title ?? "Pinned session", mode: "stored", status: "idle", updatedAt: r?.updatedAt ?? p.pinned ?? 0 };
  }

  /**
   * The session's row changed (status, mode, title, activity): the sidebar hears. `queuePaused` is
   * a queue waiting for you, so neither one the terminal holds nor one the restart wait holds.
   */
  /** A session went on under a new id (a Move, a source change's new thread, a renewed id): its side chats follow (SPEC §16a), and the `continued` event says so. */
  moveSides(from: string, to: string) {
    const ids = this.o.prefs.sideChatsOf(from);
    this.o.prefs.moveSides(from, to);
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (s) this.touch(s, { sideOf: to });
      else if (this.book.get(id)) this.book.upsert([{ ...this.book.get(id)!, sideOf: to }]);
    }
    // Modules follow it too (the peers module's who-started-whom).
    this.o.bus.emit("continued", { from, to });
  }

  touch(s: Session, patch: Partial<SessionSummary> = {}) {
    const { requests: _, queued: __, queuePaused: ___, backgroundSubagents: ____, watching: _watching, archived: _archived, pinned: _pinned, retry: _retry, scheduledAt: _scheduledAt, worktreeOf: _worktreeOf, worktreeBranch: _worktreeBranch, worktreeHandMade: _worktreeHandMade, ...rest } = { ...s.summary, ...patch };
    const beside = s.state.backgroundSubagents;
    const watching = watchingSummary(s.state.watching);
    const n = s.state.requests.length;
    // Scheduled messages (SPEC §9) aren't counted as queued: Home shows the next one's time, and one
    // that came due but waits for you (`held`) is a paused queue.
    const q = unscheduled(s.state.queue).length;
    const at = nextScheduled(s.state.queue);
    const stuck = s.state.queue.some((m) => m.held);
    const title = this.o.prefs.get(s.id).title;
    s.summary = { ...rest, ...(s.state.retry ? { retry: s.state.retry } : {}), ...(title ? { title } : {}), ...(this.o.prefs.get(s.id).archived ? { archived: true } : {}), ...(this.o.prefs.get(s.id).pinned ? { pinned: this.o.prefs.get(s.id).pinned } : {}), ...worktreeOf(this.o.prefs.get(s.id)), ...(s.state.billing ? { billing: s.state.billing } : {}), ...(s.state.cost ? { cost: s.state.cost } : {}), mode: s.state.mode, status: s.state.status, ...(n ? { requests: n } : {}), ...(q ? { queued: q } : {}), ...(beside ? { backgroundSubagents: beside } : {}), ...(watching ? { watching } : {}), ...(at !== undefined ? { scheduledAt: at } : {}), ...(stuck || (q && s.state.queueHeld && s.state.queueHeldBy !== "terminal" && !s.state.restartWait && s.state.setup !== "running" && !s.retry) ? { queuePaused: true } : {}) };
    if (this.owned(s.id) || this.book.get(s.id) || this.watched.has(s.id) || (this.pendingHarnessLogin(s.id) && this.shown(s.summary))) this.book.upsert([s.summary]);
  }
}

/** A session in a worktree Tether made: the summary names that repo's main checkout. */
const worktreeOf = (p: SessionPrefs) => (p.worktree?.repo ? { worktreeOf: p.worktree.repo, ...(p.worktree.branch ? { worktreeBranch: p.worktree.branch } : {}), ...(p.worktree.handMade ? { worktreeHandMade: true } : {}) } : {});

/** The settings fields of prefs or defaults, without empty ones. */
function pick(o: StartOpts): StartOpts {
  const out: StartOpts = {};
  if (o.model) out.model = o.model;
  if (o.effort) out.effort = o.effort;
  if (o.permissionMode) out.permissionMode = o.permissionMode;
  return out;
}

/** The settings set in Tether. A harness that's always told its model has no "default" one (picked before it went). */
export function chosenOf(a: Adapter, o: StartOpts): StartOpts {
  const out = pick(o);
  if (a.unset && out.model === "default") delete out.model;
  return out;
}
