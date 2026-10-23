// Tether runner: runs coding agents on this machine and serves them to the Tether app.
// It dials out to the app (TETHER_URL) with an app service token (TETHER_TOKEN), so the
// machine needs no inbound port.

import { existsSync, mkdirSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, resolve } from "node:path";
import type {
  HarnessId,
  Msg,
  OpName,
  Ops,
  ProjectInfo,
  RunnerToServer,
  ServerToRunner,
  SessionSearchResult,
  SessionEvent,
  SessionPulse,
  SessionSummary,
} from "../../web/src/shared/protocol";
import { kiroAdapter, opencodeAdapter } from "./adapters/acp";
import { agyHookInstalled, antigravityAdapter } from "./adapters/antigravity";
import { claudeAdapter, FALLBACK_MODELS as CLAUDE_FALLBACK_MODELS } from "./adapters/claude";
import { codexAdapter } from "./adapters/codex";
import { piAdapter } from "./adapters/pi";
import type { Adapter, Sink } from "./adapters/types";
import { config, freezeConfig, prefs, saveConfig, setUiPrefs, uiPrefs } from "./config";
import { resumeActive, runCompact, runHandoff } from "./handoffRun";
import { runFork } from "./fork";
import { applyReview, runReview } from "./review";
import { CrossAgents, isWorktreePath, listedUnder, startedByOf, subagentPath } from "./crossAgents";
import { getUsage, signedIn } from "./usage";
import { defaultOrder, saveDefaultOrder, sessionStart, suggestOrder, type HarnessFacts } from "./defaultOrder";
import { setInstalledCheck } from "./fallback";
import { clearRecent, ConflictNotifier, forgetSession, noticeListeners, notifyConflicts, recent, sendTest, subscribe, subscription, unsubscribe, vapidPublicKey } from "./notify";
import { APPROVING_MODES, byRecent, HARNESSES, isActive, listPath, parseEntry, type ChainEntry, type DiffStat, type LiveState, type PendingMessage, type SessionActivity, type SessionSnapshot } from "../../web/src/shared/protocol";
import { isCredentialId } from "../../web/src/shared/credentials";
import type { SessionPrefs } from "./config";
import { denials, editedPending, joinPending, sessionFiles, storedSlashMenu, type HandoffOpts, type LiveSession } from "./session";
import { approvalRules, removeApprovalRule, type GuardMode } from "./guard";
import { settingChange, storedSnapshot, storedState, StoredSessions, type StoredSetting } from "./stored";
import { workingTreeStats } from "./checkpoint";
import { ContextService } from "./context";
import { useContextSkills } from "./skillcmd";
import { capabilityMatrix } from "./connectors";
import {
  addServers as addMcpServers,
  finishServerAuth,
  importServers as importMcpServers,
  listServers as listMcpServers,
  setServer as setMcpServer,
  startServerAuth,
} from "./mcp/registry";
import { addHooks, importHooks, listHooks, setHook } from "./hooks";
import { addLibraryCommand, importCommands, listLibraryCommands, setLibraryCommand } from "./commands";
import { addSubagent, importSubagents, listSubagents, setSubagent } from "./subagents";
import { listSecrets, setSecret } from "./secrets";
import { credentialAction, credentialIds, credentialModels, isStatusAction, lastCredentialList, listCredentials, registerCredentialPlugins, removeCredential, testCredential } from "./credentials";
import { untilde } from "./context/paths";
import { sessionForKey, sweepBridgeFiles } from "./bridge";
import { buildPulse, ClosedPulses, PulseThrottle, TurnClock } from "./pulse";
import { scheduleChanged, sessionScheduler, setScheduler } from "./schedule";
import { checkAttachments, discard, readChunk, receiveChunk, sweepAttachments, sweepUploads } from "./attachments";
import { withAttachments } from "../../web/src/shared/attachments";
import { cloneRepo } from "./clone";
import { createProject, githubAccount, githubRepos } from "./newProject";
import { allViewed, markViewed, pickRecent, recentProjects, saveViewed, viewedAt, viewedMap } from "./viewed";
import { forgetPlans, saveStoredDraft, storedPlans } from "./planReview";

const VERSION = "0.1.0";
const URL_BASE = process.env.TETHER_URL ?? "http://localhost:8787";
const TOKEN = process.env.TETHER_TOKEN ?? "dev";

const adapters: Record<HarnessId, Adapter> = {
  "claude-code": claudeAdapter,
  codex: codexAdapter,
  pi: piAdapter,
  opencode: opencodeAdapter,
  kiro: kiroAdapter,
  antigravity: antigravityAdapter,
};

/** The harnesses installed when last checked: fallback never moves to one that isn't (fallback.ts isInstalled). */
let installedNow: Set<HarnessId> | undefined;
setInstalledCheck((h) => !installedNow || installedNow.has(h));
registerCredentialPlugins();

async function installedHarnesses(): Promise<HarnessId[]> {
  const list = (await Promise.all(Object.values(adapters).map(async (a) => ((await a.available().catch(() => false)) ? a.id : null)))).filter(Boolean) as HarnessId[];
  installedNow = new Set(list);
  return list;
}
// Kept fresh: a harness installed (or removed) while the runner runs counts from then on.
void installedHarnesses();
setInterval(() => void installedHarnesses(), 60_000).unref?.();

/** A starting point for the default order: installed harnesses with the logins this machine has, and their models. */
async function suggestedOrder(): Promise<string[]> {
  const installed = await installedHarnesses();
  const logins = await signedIn();
  const signed: Partial<Record<HarnessId, { signedIn?: boolean; account?: string }>> = {
    "claude-code": { signedIn: logins.claude },
    codex: { signedIn: !!logins.codex, account: logins.codex?.accountId },
    pi: { signedIn: !!logins.pi, account: logins.pi?.accountId },
    kiro: { signedIn: logins.kiro },
  };
  const listed = (h: HarnessId) =>
    Promise.race([adapters[h].listModels().then((r) => r.models), new Promise<[]>((ok) => setTimeout(() => ok([]), 25_000))])
      .catch(() => [])
      // Claude Code that couldn't answer: its aliases with the models they last resolved to, never a bare "opus".
      .then((ms) => (ms.length || h !== "claude-code" ? ms : CLAUDE_FALLBACK_MODELS));
  const facts: HarnessFacts[] = await Promise.all(
    HARNESSES.filter((h) => installed.includes(h.id)).map(async (h) => ({ harness: h.id, ...signed[h.id], models: await listed(h.id) })),
  );
  return suggestOrder(facts);
}

const live = new Map<string, LiveSession>();
/** sessions whose agent is starting (getLive): everyone asking waits for the same one */
const starting = new Map<string, Promise<LiveSession>>();
/** sessions that aren't running: their stored conversations, paths and event numbers (stored.ts) */
const stored = new StoredSessions(
  async (s) => adapters[s.harness].storedHistory?.(s.nativeId, s.projectPath),
  async (s) => adapters[s.harness].historyStamp?.(s.nativeId, s.projectPath),
);
// Master context: inert until the first import is run from the UI (contextImport).
const context = new ContextService({
  emit: (event) => send({ t: "context", event }),
  sessionForKey: (key) => sessionForKey(key)?.id,
  projects: () => config().projects,
  allProjects: async () => (await allProjects()).map((p) => p.path),
  onConflicts: (list) => conflictNotifier.add(list),
});
// A merge pass's contradictions go out as one push; within a minute of one, the next wait and batch.
const conflictNotifier = new ConflictNotifier({
  windowMs: 60_000,
  // Turned off while a batch waited: nothing goes out (the page it links to is off too).
  isOpen: (id) => context.enabled && context.store.conflicts().some((c) => c.id === id && c.status === "open"),
  send: (list) => {
    // Open bells refetch on a bare "sessions" message, which tabs from before this kind existed
    // handle too (a new context event type would throw in their handler).
    if (notifyConflicts(list)) send({ t: "sessions" });
  },
});
// `/skill` in the message box: the registry's skills once the master context has been imported.
useContextSkills(() => ({ enabled: context.enabled, registry: context.store.skillsDir, skills: () => context.listSkills() }));

// ---------------- connection ----------------

let ws: WebSocket | undefined;
let connected = false;
const outbox: RunnerToServer[] = [];

function send(m: RunnerToServer) {
  if (connected && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  else if (m.t !== "event") outbox.push(m); // events are re-synced by snapshots on reconnect
}

/** Applies runner-side overrides (archive, user title) and when it was last opened to a summary. */
function decorate(s: SessionSummary): SessionSummary {
  const cfg = config();
  const title = cfg.titles[s.id];
  // A stored review session (/review) is listed under the session it reviews, not on its own.
  const reviewOf = cfg.sessions[s.id]?.reviewOf?.sessionId;
  const viewed = viewedAt(s.id);
  // A cross-harness subagent: listed with the session that started it, in that one's project.
  const by = startedByOf(s.id);
  const parentId = s.startedBy?.sessionId ?? by?.sessionId;
  const parentTitle = parentId ? (cfg.titles[parentId] ?? live.get(parentId)?.title) : undefined;
  // A stored session's loops and schedules still run (the scheduler opens it when one is due).
  const runs = cfg.sessions[s.id]?.schedules;
  const nextRunAt = !s.nextRunAt && !s.live && runs?.length ? Math.min(...runs.map((r) => r.nextAt)) : undefined;
  return {
    ...s,
    ...(title ? { title } : {}),
    ...(cfg.archived.includes(s.id) ? { archived: true } : {}),
    ...(reviewOf && !s.reviewOf ? { reviewOf } : {}),
    ...(viewed ? { viewedAt: viewed } : {}),
    ...(parentId ? { startedBy: { sessionId: parentId, name: s.startedBy?.name ?? by!.name, ...(parentTitle ? { title: parentTitle } : {}) } } : {}),
    ...(by && by.projectPath !== s.projectPath ? { listedUnder: by.projectPath } : {}),
    ...(nextRunAt ? { nextRunAt } : {}),
  };
}

// ---------------- dashboard pulses ----------------

const turns = new TurnClock();
// Per-session pulse state lives as long as the session is live or among the recently finished
// (idle processes close after a few minutes, so many sessions pass through here).
const closedPulses = new ClosedPulses(50, (id) => {
  if (live.has(id)) return;
  turns.forget(id);
  pulses.forget(id);
});

function pulseOf(id: string) {
  const s = live.get(id);
  if (!s) return closedPulses.get(id);
  return buildPulse({ session: decorate(s.summary()), state: s.t.state, messages: s.t.messages, turnStartedAt: turns.turnStartedAt(id), finishedAt: turns.finishedAt(id) });
}

/**
 * With when it was last opened and its latest notice, so Home on a device following another runner
 * can tell a finished turn you haven't opened (closed pulses are stored copies: read these afresh).
 */
function withSeen(p: SessionPulse | undefined): SessionPulse | undefined {
  if (!p) return p;
  const at = viewedAt(p.session.id);
  const notice = recent().find((n) => n.sessionId === p.session.id && n.kind !== "memory");
  return { ...p, session: at ? { ...p.session, viewedAt: at } : p.session, ...(notice ? { notice } : {}) };
}

const pulses = new PulseThrottle({
  build: (id) => withSeen(pulseOf(id)),
  // Only while connected: after a reconnect browsers reload the list, and changes send afresh (resetSent).
  send: (list) => connected && send({ t: "pulse", pulses: list }),
});

noticeListeners.add((n) => n.sessionId && pulses.touch(n.sessionId));

const sink: Sink = {
  emit: (sessionId: string, seq: number, event: SessionEvent) => {
    // Whatever a session sends, even after its process ended, is where its next events go on from.
    stored.saw(sessionId, seq);
    send({ t: "event", sessionId, seq, event });
    if (event.type === "state" && event.state.status) turns.update(sessionId, event.state.status);
    pulses.touch(sessionId);
  },
  summary: (s: SessionSummary) => {
    const d = decorate(s);
    send({ t: "sessions", projectPath: listPath(d), session: d });
    if (live.has(s.id)) pulses.touch(s.id);
  },
  handoff: (from, to, reason, pendingPrompt, opts) => handoff(from, to, reason, pendingPrompt, opts),
  compact: async (from, focus) => void (await runCompact({ adapters, sink, context, track }, from, focus)),
  review: async (from, req) => void (await runReview({ adapters, sink, track }, from, req)),
  // A session that isn't running gets it in its saved settings; browsers on it hear it as a state event.
  reviewResult: (sessionId, reviewId, patch) =>
    applyReview((id) => live.get(id), sessionId, reviewId, patch, (id, reviews) => send({ t: "event", sessionId: id, seq: stored.nextSeq(id), event: { type: "state", state: { reviews } } })),
};
// Cross-harness subagents (agent_start… in tether-context): sessions that start sessions.
const agents = new CrossAgents({
  adapters,
  sink,
  track,
  live: (id) => live.get(id),
  // A parent or subagent that isn't running starts when it's needed (a message, a note).
  open: (id) => getLive(id),
  archived: () => config().archived,
  storedChanged: (id, state) => send({ t: "event", sessionId: id, seq: stored.nextSeq(id), event: { type: "state", state } }),
});
sink.agents = agents;

function handoff(from: LiveSession, to: ChainEntry, reason: string, pendingPrompt?: string, opts?: HandoffOpts) {
  return runHandoff({ adapters, sink, context, track }, from, to, reason, pendingPrompt, opts).then(() => {});
}

function connect(attempt = 0) {
  const url = URL_BASE.replace(/^http/, "ws") + "/api/runner";
  const sock = new WebSocket(url, { headers: { Authorization: `Bearer ${TOKEN}` } } as any);
  ws = sock;
  let pinger: ReturnType<typeof setInterval> | undefined;
  sock.onopen = async () => {
    connected = true;
    attempt = 0;
    console.log(`connected to ${URL_BASE}`);
    const harnesses = await installedHarnesses();
    sock.send(JSON.stringify({ t: "hello", runner: { id: config().runnerId, hostname: hostname(), version: VERSION, harnesses } } satisfies RunnerToServer));
    while (outbox.length) sock.send(JSON.stringify(outbox.shift()));
    pulses.resetSent();
    // Cloudflare closes idle WebSockets after ~100 s.
    pinger = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify({ t: "pong" })), 20_000);
  };
  sock.onmessage = (ev) => {
    let m: ServerToRunner;
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (m.t === "ping") send({ t: "pong" });
    else if (m.t === "rpc") handle(m.id, m.op, m.args);
  };
  sock.onclose = (ev) => {
    clearInterval(pinger);
    if (ws !== sock) return;
    connected = false;
    const delay = Math.min(30_000, 1_000 * 2 ** attempt);
    console.log(`disconnected (${ev.code} ${ev.reason || ""}); retrying in ${delay / 1000}s`);
    setTimeout(() => connect(attempt + 1), delay);
  };
  sock.onerror = () => {};
}

async function handle(id: string, op: OpName, args: any) {
  try {
    if (!ops[op]) throw new Error(`This runner doesn't know "${op}": it's older than the web app. Restart it to update.`);
    const data = await (ops[op] as (a: any) => Promise<unknown>)(args ?? {});
    send({ t: "result", id, ok: true, data });
  } catch (e: any) {
    send({ t: "result", id, ok: false, error: e?.message ?? String(e) });
  }
}

// ---------------- sessions ----------------

function track(s: LiveSession) {
  live.set(s.id, s);
  closedPulses.delete(s.id);
  s.onClose = () => {
    // Browsers keep counting its events: a new process (or a change while closed) goes on from here.
    stored.closed(s.id, s.seq, s.projectPath);
    // Its last pulse stays for "Recently finished" (a removed session is archived: browsers drop it).
    const last = pulseOf(s.id);
    if (live.get(s.id) === s) live.delete(s.id);
    if (last) closedPulses.put(last);
    pulses.touch(s.id);
  };
  s.loadPrefs();
  return s;
}

function parseId(sessionId: string): { harness: HarnessId; nativeId: string } {
  const i = sessionId.indexOf(":");
  const harness = sessionId.slice(0, i) as HarnessId;
  if (!adapters[harness]) throw new Error(`unknown harness in ${sessionId}`);
  return { harness, nativeId: sessionId.slice(i + 1) };
}

/** Where a session is, without starting it: known, else searched for in every project. */
async function sessionPath(sessionId: string, projectPath?: string): Promise<string> {
  const { harness, nativeId } = parseId(sessionId);
  const known = projectPath ?? live.get(sessionId)?.projectPath ?? stored.path(sessionId) ?? config().sessions[sessionId]?.projectPath;
  if (known) return known;
  for (const p of await allProjects()) {
    if ((await adapters[harness].listSessions(p.path)).some((s) => s.nativeId === nativeId)) return p.path;
  }
  throw new Error(`session ${sessionId} not found`);
}

/** The session's agent, started (resumed) if it isn't running: for whatever needs the agent itself. */
async function getLive(sessionId: string, projectPath?: string): Promise<LiveSession> {
  // One still starting is handed out only once its saved choices are back (it's tracked before that).
  const pending = starting.get(sessionId);
  if (pending) return pending;
  const existing = live.get(sessionId);
  if (existing && !existing.closed) return existing;
  const p = startLive(sessionId, projectPath).finally(() => starting.delete(sessionId));
  starting.set(sessionId, p);
  return p;
}

async function startLive(sessionId: string, projectPath?: string): Promise<LiveSession> {
  const { harness, nativeId } = parseId(sessionId);
  // A subagent works in its own worktree: never in the parent's checkout instead (crossAgents.ts).
  const by = config().sessions[sessionId]?.startedBy;
  const path = by ? await subagentPath(sessionId, config().sessions[sessionId]?.projectPath) : await sessionPath(sessionId, projectPath);
  const s = await adapters[harness].resume(nativeId, path, sink);
  // Its events go on from where browsers left off.
  s.seq = stored.seq(sessionId);
  // Harnesses that take the guard as a launch setting see the saved one (loadPrefs restores the rest).
  const guard = config().sessions[sessionId]?.guard;
  if (guard) s.t.state.guard = guard;
  // Its credential, so the resumed process gets that credential's env again (credentialLaunch).
  const credential = config().sessions[sessionId]?.credential;
  if (credential) s.t.state.credential = credential;
  await s.start();
  // Read just before loadPrefs (in track) saves what it started on over them; nothing saves before.
  const saved = config().sessions[sessionId];
  const choices = saved && { model: saved.model, thinking: saved.thinking, permissionMode: saved.permissionMode };
  track(s);
  await s.reapplyChoices(choices);
  return s;
}

/** The session's agent if it's running, or the one starting; undefined (synchronously) when neither. */
function current(sessionId: string): LiveSession | Promise<LiveSession | undefined> | undefined {
  const p = starting.get(sessionId);
  if (p) return p.catch(() => undefined);
  const s = live.get(sessionId);
  return s && !s.closed ? s : undefined;
}

/** The session's agent if it's running (or starting); undefined when it isn't. */
async function runningLive(sessionId: string): Promise<LiveSession | undefined> {
  return current(sessionId);
}

/** What opening a session that isn't running shows, without starting it; undefined when only its agent can show it. */
async function storedSessionSnapshot(sessionId: string, projectPath?: string): Promise<SessionSnapshot | undefined> {
  const { harness, nativeId } = parseId(sessionId);
  const a = adapters[harness];
  if (!a.storedHistory) return undefined;
  const path = await sessionPath(sessionId, projectPath);
  const summary = (await a.listSessions(path)).find((x) => x.nativeId === nativeId);
  if (!summary) return undefined;
  const history = await stored.history(summary);
  if (!history) return undefined;
  const p = config().sessions[sessionId];
  // What the whole session changed, measured now (a running session measures it after each turn).
  const base = p?.diffBaseSha ?? p?.checkpoints?.[0]?.sha;
  const diffStat = base ? await totalChanges(path, base) : undefined;
  const state = storedState({ prefs: p, history, modes: a.modes, plans: storedPlans(sessionId), defaultGuard: config().guard?.defaultMode ?? "auto", diffStat });
  if (p?.guardUntil && p.guard === "full" && p.guardUntil > Date.now()) state.guardUntil = p.guardUntil;
  return storedSnapshot(decorate(summary), history, state, stored.seq(sessionId), p?.blocked);
}

/** What a session changed since its first snapshot, measured at most every few seconds (several devices open it at once). */
const changesCache = new Map<string, { at: number; stat: Promise<DiffStat | undefined> }>();
function totalChanges(path: string, base: string): Promise<DiffStat | undefined> {
  const key = `${path}\0${base}`;
  const hit = changesCache.get(key);
  if (hit && Date.now() - hit.at < 5_000) return hit.stat;
  const stat = workingTreeStats(path, [base]).then(([total]) => total).catch(() => undefined);
  changesCache.set(key, { at: Date.now(), stat });
  for (const [k, v] of changesCache) if (Date.now() - v.at >= 5_000) changesCache.delete(k);
  return stat;
}

/** Saves a change to a session that isn't running; browsers on it hear it as a state event. */
function writeStored(sessionId: string, saved: Partial<SessionPrefs>, state: Partial<LiveState>, path?: string) {
  Object.assign(prefs(sessionId), saved, path ? { projectPath: path } : {});
  saveConfig();
  send({ t: "event", sessionId, seq: stored.nextSeq(sessionId), event: { type: "state", state } });
}

/**
 * A setting: on the running (or starting) agent, else saved with its other settings and applied
 * when it starts (startLive: reapplyChoices, loadPrefs). Nothing is awaited between checking
 * whether it runs and saving, so a start can't read the old value in between.
 */
async function changeSetting(
  sessionId: string,
  setting: StoredSetting,
  onLive: (s: LiveSession) => unknown,
  /** more to save (and show) with it for a session that isn't running */
  more?: (saved: SessionPrefs) => [Partial<SessionPrefs>, Partial<LiveState>],
) {
  const { harness } = parseId(sessionId);
  const path = await sessionPath(sessionId).catch(() => undefined);
  const now = current(sessionId);
  const s = now instanceof Promise ? await now : now;
  if (s) return void (await onLive(s));
  const change = settingChange(harness, setting);
  const [saved, state] = more?.(prefs(sessionId)) ?? [{}, {}];
  writeStored(sessionId, { ...(change as Partial<SessionPrefs>), ...saved }, { ...change, ...state }, path);
}

/** Clears a LiveState field in every browser (an undefined field doesn't survive JSON). */
const CLEARED = null as unknown as undefined;

/**
 * Timed full access on a session that isn't running (Settings → its picker, or it stopped since):
 * saved with its settings; the sweep below puts the mode back when it ends. A running session's
 * own timer does that (LiveSession.setGuard).
 */
function timedGuard(mode: GuardMode, minutes: number | undefined) {
  return (p: SessionPrefs): [Partial<SessionPrefs>, Partial<LiveState>] => {
    if (mode !== "full" || !minutes || minutes <= 0) return [{ guardUntil: undefined, guardBefore: undefined, guardEnded: undefined }, p.guardUntil ? { guardUntil: CLEARED } : {}];
    const cur = p.guard ?? config().guard?.defaultMode ?? "auto";
    const before = p.guardUntil ? p.guardBefore : cur;
    const until = Date.now() + Math.min(minutes, 24 * 60) * 60_000;
    return [{ guardUntil: until, guardBefore: before && before !== "full" ? before : "auto", guardEnded: undefined }, { guardUntil: until }];
  };
}

/** Ends timed full access on sessions that aren't running (running ones end it themselves). */
function sweepTimedGuards() {
  const now = Date.now();
  for (const [id, p] of Object.entries(config().sessions)) {
    if (!p.guardUntil || p.guardUntil > now || current(id)) continue;
    const back = p.guardBefore && p.guardBefore !== "full" ? p.guardBefore : (config().guard?.defaultMode ?? "auto");
    // The inline "Full access ended" waits for it to open again (loadPrefs).
    writeStored(id, { guard: back, guardUntil: undefined, guardBefore: undefined, guardEnded: back }, { guard: back, guardUntil: CLEARED });
  }
}
setInterval(sweepTimedGuards, 30_000);

/** Messages held on a session that isn't running (shown held; sending starts it). */
function storedPending(sessionId: string) {
  return config().sessions[sessionId]?.pending ?? [];
}

function setStoredPending(sessionId: string, list: PendingMessage[]) {
  writeStored(sessionId, { pending: list.length ? list : undefined }, { pending: list, pendingHeld: list.length ? true : undefined });
}

/** A running session's changes and files, else the ones its saved settings describe: never starts it. */
async function filesOf(sessionId: string) {
  const s = await runningLive(sessionId);
  if (s) return s.files;
  const p = config().sessions[sessionId];
  return sessionFiles({ projectPath: await sessionPath(sessionId), diffBase: p?.diffBaseSha, checkpoints: p?.checkpoints });
}

// Scanning every harness's session store takes seconds; serve a cached copy and refresh it behind.
let projectCache: { at: number; lists: Awaited<ReturnType<Adapter["listProjects"]>>[] } | undefined;
let projectScan: Promise<void> | undefined;
function scanProjects() {
  projectScan ??= Promise.all(Object.values(adapters).map((a) => a.listProjects().catch(() => [])))
    .then((lists) => void (projectCache = { at: Date.now(), lists }))
    .finally(() => (projectScan = undefined));
  return projectScan;
}

async function allProjects(): Promise<ProjectInfo[]> {
  const cfg = config();
  const by = new Map<string, ProjectInfo>();
  if (!projectCache) await scanProjects();
  else if (Date.now() - projectCache.at > 15_000) scanProjects();
  const lists = projectCache!.lists;
  for (const list of lists)
    for (const p of list) {
      const cur = by.get(p.path) ?? { path: p.path, name: basename(p.path) || p.path, sessionCount: 0, updatedAt: 0, pinned: false, live: [] };
      cur.sessionCount += p.count;
      cur.updatedAt = Math.max(cur.updatedAt, p.updatedAt);
      by.set(p.path, cur);
    }
  for (const path of cfg.projects) {
    const cur = by.get(path) ?? { path, name: basename(path) || path, sessionCount: 0, updatedAt: 0, pinned: true, live: [] };
    cur.pinned = true;
    by.set(path, cur);
  }
  for (const s of live.values())
    if (!s.closed) {
      const d = decorate(s.summary());
      by.get(listPath(d))?.live.push(d);
    }
  return [...by.values()]
    // Subagents' worktrees are listed with the project they came from.
    .filter((p) => existsSync(p.path) && !isWorktreePath(p.path))
    .map((p) => (cfg.hidden.includes(p.path) ? { ...p, archived: true } : p))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

function expand(path: string) {
  return resolve(untilde(path)); // $HOME, like every context path (context/paths.ts)
}

async function addProject(p: string, create = false): Promise<ProjectInfo> {
  if (create && !existsSync(p)) mkdirSync(p, { recursive: true });
  if (!existsSync(p)) throw new Error(`${p} doesn't exist`);
  if (!statSync(p).isDirectory()) throw new Error(`${p} is a file, not a folder`);
  const cfg = config();
  if (!cfg.projects.includes(p)) cfg.projects.push(p);
  cfg.hidden = cfg.hidden.filter((h) => h !== p);
  saveConfig();
  return (await allProjects()).find((x) => x.path === p)!;
}

async function projectSessions(projectPath: string): Promise<SessionSummary[]> {
  const stored = (await Promise.all(Object.values(adapters).map((a) => a.listSessions(projectPath).catch(() => [])))).flat();
  // Subagents started from here that work in their own worktrees are listed here too.
  const away = listedUnder(projectPath);
  for (const dir of new Set(away.map((x) => x.projectPath))) {
    const ids = new Set(away.filter((x) => x.projectPath === dir).map((x) => x.id));
    for (const a of Object.values(adapters)) for (const s of await a.listSessions(dir).catch(() => [])) if (ids.has(s.id)) stored.push(s);
  }
  const out = new Map(stored.map((s) => [s.id, s]));
  for (const s of live.values()) if (!s.closed && (s.projectPath === projectPath || s.t.state.startedBy?.projectPath === projectPath)) out.set(s.id, s.summary());
  return [...out.values()].map(decorate).sort(byRecent);
}

type IndexedUserMessage = { ts: number; text: string };
const searchableMessages = new Map<string, { updatedAt: number; messages: IndexedUserMessage[] }>();
const searchLoads = new Map<string, { updatedAt: number; promise: Promise<IndexedUserMessage[]> }>();
let searchableChars = 0;
const MAX_SEARCHABLE_CHARS = 8_000_000;

function cacheSearchableMessages(session: SessionSummary, messages: IndexedUserMessage[]) {
  const previous = searchableMessages.get(session.id);
  if (previous) searchableChars -= previous.messages.reduce((n, message) => n + message.text.length, 0);
  searchableMessages.delete(session.id);
  const size = messages.reduce((n, message) => n + message.text.length, 0);
  if (size > MAX_SEARCHABLE_CHARS) return;
  searchableMessages.set(session.id, { updatedAt: session.updatedAt, messages });
  searchableChars += size;
  while (searchableChars > MAX_SEARCHABLE_CHARS || searchableMessages.size > 2000) {
    const oldestId = searchableMessages.keys().next().value;
    if (!oldestId) break;
    const oldest = searchableMessages.get(oldestId)!;
    searchableChars -= oldest.messages.reduce((n, message) => n + message.text.length, 0);
    searchableMessages.delete(oldestId);
  }
}

async function userMessages(session: SessionSummary): Promise<IndexedUserMessage[]> {
  const active = live.get(session.id);
  if (active && !active.closed) return indexUserMessages(active.t.messages);
  const cached = searchableMessages.get(session.id);
  if (cached?.updatedAt === session.updatedAt) return cached.messages;
  const pending = searchLoads.get(session.id);
  if (pending?.updatedAt === session.updatedAt) return pending.promise;
  const readHistory = adapters[session.harness].readHistory;
  if (!readHistory) return [];
  const promise = readHistory(session.nativeId, session.projectPath).then((transcript) => {
    const messages = indexUserMessages(transcript);
    cacheSearchableMessages(session, messages);
    return messages;
  });
  searchLoads.set(session.id, { updatedAt: session.updatedAt, promise });
  try {
    return await promise;
  } finally {
    if (searchLoads.get(session.id)?.promise === promise) searchLoads.delete(session.id);
  }
}

function indexUserMessages(messages: Msg[]): IndexedUserMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "user") return [];
    const text = message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
    return text ? [{ ts: message.ts, text }] : [];
  });
}

function excerpt(text: string, query: string): string {
  const lower = text.toLocaleLowerCase();
  const at = lower.indexOf(query);
  const start = Math.max(0, at - 90);
  const end = Math.min(text.length, at + query.length + 110);
  return `${start ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

async function findSessionMatches(queryText: string): Promise<SessionSearchResult[]> {
  const terms = queryText.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const projects = await allProjects();
  const sessions = (await Promise.all(projects.map((project) => projectSessions(project.path)))).flat();
  const matches: SessionSearchResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < sessions.length) {
      const session = sessions[next++]!;
      const title = session.title.toLocaleLowerCase();
      if (terms.every((term) => title.includes(term))) {
        matches.push({ session, excerpt: session.title, ts: session.updatedAt });
        continue;
      }
      try {
        const messages = await userMessages(session);
        const hit = [...messages].reverse().find((message) => {
          const lower = message.text.toLocaleLowerCase();
          return terms.every((term) => lower.includes(term));
        });
        if (hit) matches.push({ session, excerpt: excerpt(hit.text, terms[0]!), ts: hit.ts || session.updatedAt });
      } catch {
        // A harness may have removed or locked a stored transcript since its summary was listed.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, sessions.length) }, worker));
  return matches.sort((a, b) => byRecent(a.session, b.session));
}

// ---------------- ops ----------------

const recentCache = new Map<number, { at: number; list: Promise<SessionSummary[]> }>();

type Handlers ={ [K in OpName]: (args: Ops[K]["args"]) => Promise<Ops[K]["result"]> };

const ops: Handlers = {
  async listProjects() {
    return allProjects();
  },

  async addProject({ path, create }) {
    return addProject(expand(path), create);
  },

  async createProject({ name, parent, github }) {
    return addProject(await createProject({ name, parent: expand(parent || "~"), github }));
  },

  async githubAccount() {
    return (await githubAccount()) ?? null;
  },

  async githubRepos({ owner }) {
    return githubRepos(owner);
  },

  async cloneProject({ repo, parent }) {
    return addProject(await cloneRepo(repo, expand(parent || "~")));
  },

  async removeProject({ path }) {
    const cfg = config();
    cfg.projects = cfg.projects.filter((p) => p !== path);
    if (!cfg.hidden.includes(path)) cfg.hidden.push(path);
    saveConfig();
    return {};
  },

  async archiveProject({ path, archived }) {
    const cfg = config();
    cfg.hidden = cfg.hidden.filter((h) => h !== path);
    if (archived) cfg.hidden.push(path);
    saveConfig();
    return {};
  },

  async listDirs({ path }) {
    const p = expand(path || "~");
    const entries = await readdir(p, { withFileTypes: true }).catch((e) => {
      // The web app offers to create a folder that doesn't exist (and only that).
      throw e?.code === "ENOENT" ? new Error(`${p} doesn't exist`) : e?.code === "ENOTDIR" ? new Error(`${p} is a file, not a folder`) : e;
    });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => e.name)
      .sort();
    return { path: p, dirs: p === "/" ? dirs : ["..", ...dirs].map((d) => (d === ".." ? dirname(p) : resolve(p, d))) };
  },

  async listSessions({ projectPath }) {
    return projectSessions(projectPath);
  },

  async searchSessions({ query }) {
    const clean = query.trim().slice(0, 200);
    return clean ? findSessionMatches(clean) : [];
  },

  async createSession({ projectPath, harness: asked, model: askedModel, defaultOrder: useOrder, prompt, permissionMode, guard }) {
    const installed = useOrder ? await installedHarnesses() : [];
    const { harness, model, credential, chain } = sessionStart({ harness: asked, model: askedModel, useOrder }, defaultOrder(), (h) => installed.includes(h));
    const a = adapters[harness];
    if (!a) throw new Error(`unknown harness ${harness}`);
    // The mode was picked for the harness asked for: another one (the order's first entry was out) starts in its own.
    const mode = harness === asked && permissionMode && !APPROVING_MODES.has(permissionMode) ? permissionMode : undefined;
    const s = a.create(expand(projectPath), { model, permissionMode: mode }, sink);
    // Set before start() so harnesses that take it as a launch flag (Antigravity) see it.
    s.t.state.guard = guard ?? config().guard?.defaultMode ?? "auto";
    // So is the credential: start() gives its process that credential's env (credentialLaunch).
    if (credential) s.t.state.credential = credential;
    await s.start();
    track(s);
    s.setState({ guard: s.t.state.guard });
    if (chain) await s.setChain(chain);
    if (prompt) await s.prompt(prompt);
    sink.summary(s.summary());
    return s.summary();
  },

  async openSession({ sessionId, projectPath }) {
    // Opening only shows the conversation: the agent starts when something needs it.
    const running = await runningLive(sessionId);
    if (running) return running.snapshot();
    const snap = await storedSessionSnapshot(sessionId, projectPath).catch((e) => {
      console.error(`reading ${sessionId} without its agent failed: ${e?.message ?? e}`);
      return undefined;
    });
    // It started while the stored copy was read (a message from another device): what it has now
    // wins, or the browser would take the stored copy (not running) over the events it dropped meanwhile.
    const started = await runningLive(sessionId);
    if (started) return started.snapshot();
    // Harnesses that can't show a conversation without their agent (Kiro), or a store that couldn't be read.
    return snap ?? (await getLive(sessionId, projectPath)).snapshot();
  },

  async closeSession({ sessionId }) {
    live.get(sessionId)?.close();
    return {};
  },

  async archiveSession({ sessionId, archived }) {
    const cfg = config();
    cfg.archived = cfg.archived.filter((id) => id !== sessionId);
    if (archived) {
      cfg.archived.push(sessionId);
      // Its cross-harness subagents stop with it.
      await agents.stopAll(sessionId).catch(() => {});
      const s = live.get(sessionId);
      if (s && s.t.state.status === "idle") s.close();
    }
    saveConfig();
    // Its loops and schedules wait while it's marked done, and run again once it's back.
    scheduleChanged();
    return {};
  },

  async removeSession({ sessionId }) {
    const cfg = config();
    // Archived first, so the closing summary already carries it.
    if (!cfg.archived.includes(sessionId)) cfg.archived.push(sessionId);
    // Its cross-harness subagents stop with it; their worktrees go unless they hold work (commits or changes).
    await agents.stopAll(sessionId).catch(() => {});
    void agents
      .removed(sessionId)
      .then((kept) => kept.length && console.log(`${sessionId} removed; subagent worktrees kept (they hold work): ${kept.join(", ")}`))
      .catch((e) => console.error(`subagent worktrees of ${sessionId}: ${e?.message ?? e}`));
    const s = live.get(sessionId);
    if (s && !s.closed) {
      // Abort a running turn cleanly, but never let a stuck harness keep the process alive.
      if (s.busy) await Promise.race([s.stop().catch(() => {}), new Promise((r) => setTimeout(r, 3_000))]);
      s.close();
    }
    // Every browser's Home drops it now, including one that only had it under Recently finished
    // (whose stored pulse predates the archive), and a later listPulses doesn't bring it back.
    const last = pulseOf(sessionId);
    closedPulses.delete(sessionId);
    pulses.forget(sessionId);
    turns.forget(sessionId);
    if (last && connected) send({ t: "pulse", pulses: [{ session: { ...last.session, archived: true } }] });
    // Nothing to resume or resend after a runner restart.
    const p = cfg.sessions[sessionId];
    // Nor any loop or schedule to run.
    if (p) Object.assign(p, { active: false, pending: undefined, background: undefined, schedules: undefined, blocked: undefined });
    forgetSession(sessionId);
    denials.forget(sessionId);
    forgetPlans(sessionId);
    stored.forget(sessionId);
    saveConfig();
    scheduleChanged();
    return {};
  },

  async prompt({ sessionId, text, mode, attachments }) {
    // Checked before anything happens: every file must be a stored attachment.
    const files = checkAttachments(attachments);
    if (files.length) {
      if (text.startsWith("!")) throw new Error("Bash mode can't take attachments.");
      text = withAttachments(text, files);
    }
    const s = await getLive(sessionId);
    // Talking to a session marked done brings it back to the lists.
    const cfg = config();
    if (cfg.archived.includes(sessionId)) {
      cfg.archived = cfg.archived.filter((id) => id !== sessionId);
      saveConfig();
      scheduleChanged();
      sink.summary(s.summary());
    }
    // Tether's own commands, before the shell output rides along: `/tether …` (dev only), `/goal …`
    // (goal.ts), /loop and /schedule (schedule.ts), `/compact [focus]` (the harness's own compaction,
    // or a restart on a brief: fork.ts, handoffRun.ts), `/review …` (a read-only review session on
    // another harness: review.ts). Held open meanwhile (the idle close waits).
    if (await s.hold(() => s.tetherCommand(text))) return {};
    if (text.startsWith("!")) {
      const command = text.slice(1).trim();
      if (command) void s.runShell(command).catch((e) => s.notice(`Shell command failed: ${e?.message ?? e}`, "error"));
      return {};
    }
    await s.prompt(s.withShellContext(text), mode);
    return {};
  },

  async forceSend({ sessionId, text, id, attachments }) {
    if (id) {
      // A message held on a session that isn't running: starting it brings the message back (loadPrefs).
      let s = await runningLive(sessionId);
      if (!s && !storedPending(sessionId).some((p) => p.id === id)) throw new Error("That message was already sent.");
      s ??= await getLive(sessionId);
      await s.forceSend({ id });
      return {};
    }
    const files = checkAttachments(attachments);
    if (!text?.trim() && !files.length) throw new Error("Nothing to send.");
    if (text?.startsWith("!")) throw new Error("A shell command can't interrupt the agent. Send it normally.");
    // Not running: nothing to stop, it just starts with this message.
    const s = await getLive(sessionId);
    // Tether's own commands (/goal, /compact…) first, as typed, like prompt: no shell output rides along.
    if (!files.length && text && (await s.hold(() => s.tetherCommand(text)))) return {};
    await s.forceSend({ text: s.withShellContext(files.length ? withAttachments(text ?? "", files) : (text ?? "")) });
    return {};
  },

  async uploadAttachment(args) {
    return receiveChunk(args);
  },

  async discardAttachment({ sessionId, path, uploadId }) {
    await discard(sessionId, { path, uploadId }).catch(() => {});
    return {};
  },

  async readAttachment({ path, offset, length }) {
    return readChunk(path, offset ?? 0, length);
  },

  async abort({ sessionId }) {
    // Not running: nothing to stop.
    await (await runningLive(sessionId))?.stop();
    return {};
  },

  async deleteSchedule({ sessionId, id }) {
    // Never starts the agent: a session that isn't running has it removed from its saved list.
    const now = current(sessionId);
    const s = now instanceof Promise ? await now : now;
    if (s) {
      s.deleteSchedule(id);
      return {};
    }
    const p = config().sessions[sessionId];
    if (p?.schedules) {
      const left = p.schedules.filter((x) => x.id !== id);
      // Browsers on it hear the shorter list (writeStored saves it).
      writeStored(sessionId, { schedules: left.length ? left : undefined }, { schedules: left });
      scheduleChanged();
    }
    return {};
  },

  async editPending({ sessionId, id, ...change }) {
    const now = current(sessionId);
    let s = now instanceof Promise ? await now : now;
    if (!s && !change.now) {
      // Held on a session that isn't running: edited in its saved list (throws when it's gone).
      setStoredPending(sessionId, editedPending(storedPending(sessionId), id, change));
      return {};
    }
    // "Send now" starts it; the held messages come back with it (loadPrefs).
    if (!s && !storedPending(sessionId).some((p) => p.id === id)) throw new Error("That message was already sent.");
    s ??= await getLive(sessionId);
    await s.editPending(id, change);
    return {};
  },

  async takePending({ sessionId }) {
    const now = current(sessionId);
    const s = now instanceof Promise ? await now : now;
    if (s) return { text: s.takePending() };
    const list = storedPending(sessionId);
    if (list.length) setStoredPending(sessionId, []);
    return { text: list.length ? joinPending(list) : "" };
  },

  async pushStatus({ endpoint }) {
    return { publicKey: vapidPublicKey(), kinds: endpoint ? subscription(endpoint)?.kinds : undefined };
  },

  async pushSubscribe({ subscription: sub, kinds, label }) {
    if (!/^https:\/\//.test(sub.endpoint)) throw new Error("Push endpoints must be https");
    subscribe({ endpoint: sub.endpoint, keys: sub.keys, kinds, label });
    return {};
  },

  async pushUnsubscribe({ endpoint }) {
    unsubscribe(endpoint);
    return {};
  },

  async pushTest({ endpoint }) {
    await sendTest(endpoint);
    return {};
  },

  async listNotifications() {
    return recent();
  },

  async clearNotifications() {
    clearRecent();
    return {};
  },

  async amendSteer({ sessionId, msgId, text }) {
    const s = await runningLive(sessionId);
    if (!s) throw new Error("That message can't be changed any more: the turn it went into has ended.");
    s.amendSteer(msgId, text);
    return {};
  },

  async setModel({ sessionId, model, defaultOrder: useOrder }) {
    await changeSetting(sessionId, { op: "model", model, defaultOrder: useOrder }, (s) => s.setModelOrOrder(model, useOrder));
    return {};
  },

  async setGuard({ sessionId, mode, minutes }) {
    if (minutes !== undefined && (typeof minutes !== "number" || !(minutes > 0))) throw new Error("minutes must be a positive number");
    await changeSetting(sessionId, { op: "guard", mode }, (s) => s.setGuard(mode, minutes), timedGuard(mode, minutes));
    return {};
  },

  async listApprovalRules() {
    return approvalRules();
  },

  async removeApprovalRule({ id, index }) {
    return removeApprovalRule({ id, index });
  },

  async getSessionDiff({ sessionId, checkpoint }) {
    return (await filesOf(sessionId)).diff(checkpoint);
  },

  async checkPaths({ sessionId, paths }) {
    if (!Array.isArray(paths)) throw new Error("paths must be a list");
    return (await filesOf(sessionId)).checkPaths(paths);
  },

  async fileDiff({ sessionId, path, checkpoint, reveal }) {
    return (await filesOf(sessionId)).fileDiff(String(path ?? ""), typeof checkpoint === "string" ? checkpoint : undefined, reveal === true);
  },

  async readFile({ sessionId, path, maxBytes, reveal }) {
    return (await filesOf(sessionId)).readFile(String(path ?? ""), maxBytes, reveal === true);
  },

  async readFileChunk({ sessionId, path, offset, length, reveal }) {
    return (await filesOf(sessionId)).readFileChunk(String(path ?? ""), offset, length, reveal === true);
  },

  async approveBlocked({ sessionId, toolId, confirmed }) {
    const r = await (await getLive(sessionId)).approveBlocked(toolId, confirmed === true);
    // Its blocked notice is gone: open bells and Homes refetch.
    send({ t: "sessions" });
    return r;
  },

  async forkSession({ sessionId, msgId, harness, model, prompt }) {
    if (!adapters[harness]) throw new Error(`unknown harness ${harness}`);
    const next = await runFork({ adapters, sink, context, track }, await getLive(sessionId), { msgId, harness, model, prompt });
    return next.summary();
  },

  async sendReviewFindings({ sessionId, reviewId, indexes }) {
    if (indexes !== undefined && !Array.isArray(indexes)) throw new Error("indexes must be a list");
    // Starts it when it isn't running (its reviews come back with its saved settings, loadPrefs).
    await (await getLive(sessionId)).sendReviewFindings(reviewId, indexes);
    return {};
  },

  async continueOn({ sessionId, msgId }) {
    // The offer lives with the process that hit the error: once it has closed, a message goes on
    // (on the model the session's settings pick; they can be changed while it's stopped).
    const s = await runningLive(sessionId);
    if (!s) throw new Error("This session's agent has stopped since that error. Send a message to go on, after changing the model if you like.");
    await s.hold(() => s.continueOn(msgId));
    return {};
  },

  async runBlocked({ sessionId, toolId, confirmed }) {
    const r = await (await getLive(sessionId)).runBlocked(toolId, confirmed === true);
    send({ t: "sessions" });
    return r;
  },

  async stopActivity({ sessionId, id }) {
    const s = await runningLive(sessionId);
    if (!s) throw new Error("That item is no longer listed.");
    await s.stopActivity(id);
    return {};
  },

  async listActivity({ recentMs }) {
    const since = Date.now() - (recentMs ?? 0);
    const out: SessionActivity[] = [];
    for (const s of live.values()) {
      if (s.closed) continue;
      const items = (s.t.state.activity ?? []).filter((a) => isActive(a) || (recentMs && (a.endedAt ?? 0) >= since));
      if (items.length) out.push({ session: decorate(s.summary()), items });
    }
    return out.sort((a, b) => b.items.filter(isActive).length - a.items.filter(isActive).length || b.session.updatedAt - a.session.updatedAt);
  },

  async listPulses() {
    const out = [...live.values()].filter((s) => !s.closed).map((s) => pulseOf(s.id)!);
    for (const p of closedPulses.list()) if (!live.has(p.session.id)) out.push(p);
    return out.filter((p) => !p.session.archived).map((p) => withSeen(p)!);
  },

  async guardSetup({ judgeModel, defaultMode }) {
    const cfg = config();
    if (defaultMode) {
      cfg.guard = { ...cfg.guard, defaultMode };
      saveConfig();
    }
    // Legacy clients: "off" turns the judge off, any model turns it on. The model itself is the
    // shared background model (setBackgroundModel); it is not changed here.
    if (judgeModel) context.setJudgeEnabled(judgeModel !== "off");
    const bg = context.backgroundModel();
    return { antigravityHook: agyHookInstalled(), judgeModel: bg.judge ? bg.model : "off", judgeEnabled: bg.judge, defaultMode: cfg.guard?.defaultMode ?? "auto" };
  },

  async setChain({ sessionId, chain, preferEarlier }) {
    // A list of entries; one on a credential names one this runner has (as the default order's are checked).
    if (!Array.isArray(chain) || chain.some((e) => typeof e !== "string" || !e.trim())) throw new Error('A chain is a list of "harness:model" entries.');
    const creds = chain.map((e) => parseEntry(e, "claude-code").credential).filter((c): c is string => !!c);
    if (creds.length) {
      const ids = await credentialIds();
      const bad = creds.find((c) => !isCredentialId(c) || !ids.has(c));
      if (bad) throw new Error(isCredentialId(bad) ? `${bad} isn't on this runner. Nothing was changed.` : `“${bad}” isn't an account or key. Nothing was changed.`);
    }
    await changeSetting(sessionId, { op: "chain", chain, preferEarlier }, (s) => s.setChain(chain, preferEarlier));
    return {};
  },

  async setThinking({ sessionId, level }) {
    await changeSetting(sessionId, { op: "thinking", level }, (s) => s.setThinking(level));
    return {};
  },

  async setPermissionMode({ sessionId, mode }) {
    // The picker never offers these; refuse them here too so no client can skip the guard.
    if (APPROVING_MODES.has(mode)) throw new Error(`${mode} approves tool calls without the guard; use the guard setting instead.`);
    await changeSetting(sessionId, { op: "mode", mode }, (s) => s.setPermissionMode(mode));
    return {};
  },

  async setPlanDraft({ sessionId, planId, draft, base }) {
    // A draft never starts an agent: a session that isn't running gets it in its file.
    const s = live.get(sessionId);
    parseId(sessionId);
    if ((!s || s.closed) && config().archived.includes(sessionId)) throw new Error("That session was archived or removed; its drafts weren't kept.");
    const b = typeof base === "number" ? base : undefined;
    return s && !s.closed ? s.plans.setDraft(String(planId), draft, b) : saveStoredDraft(sessionId, String(planId), draft, b);
  },

  async planAction({ sessionId, planId, action, draft, base }) {
    if (!["discuss", "revise", "approve"].includes(action)) throw new Error(`unknown plan action ${action}`);
    const s = await getLive(sessionId);
    // Held open until the action has reached the agent (the idle close waits).
    await s.hold(() => s.plans.act(String(planId), action, draft, typeof base === "number" ? base : undefined));
    return {};
  },

  async uiRespond({ sessionId, response }) {
    // stale: no such request is waiting (answered elsewhere, timed out, cancelled by a stop or the process ending)
    const s = await runningLive(sessionId);
    return s?.uiRespond(response) ? {} : { stale: true };
  },

  async getUsage({ force }) {
    return getUsage(force);
  },

  async renameSession({ sessionId, projectPath, title }) {
    const cfg = config();
    title = title.replace(/\s+/g, " ").trim().slice(0, 200);
    if (title) cfg.titles[sessionId] = title;
    else delete cfg.titles[sessionId];
    saveConfig();
    // Also rename in the harness when its process is up; the stored title covers the rest.
    const s = live.get(sessionId);
    if (s && !s.closed) {
      if (title) await s.rename(title).catch(() => s.setTitle(title));
      sink.summary(s.summary());
    } else {
      const found = (await ops.listSessions({ projectPath })).find((x) => x.id === sessionId);
      if (found) sink.summary(found);
    }
    return {};
  },

  async listModels({ harness, sessionId }) {
    const s = sessionId ? live.get(sessionId) : undefined;
    const [own, onCredentials] = await Promise.all([adapters[harness].listModels(s), credentialModels(harness).catch(() => [])]);
    // The harness's own login's models, then the ones credentials serve on it ("GPT-6 Luna · Azure").
    return onCredentials.length ? { ...own, models: [...own.models, ...onCredentials] } : own;
  },

  async getDefaultOrder({ suggest }) {
    const order = defaultOrder();
    if (order || !suggest) return { order };
    return { suggested: await suggestedOrder() };
  },

  async setDefaultOrder({ order }) {
    const usesCredential = Array.isArray(order) && order.some((e) => typeof e === "string" && e.includes("#"));
    return { order: saveDefaultOrder(order, usesCredential ? await credentialIds() : undefined) };
  },

  // ---- credentials (runner/src/credentials) ----

  async listCredentials() {
    return listCredentials({ order: defaultOrder() });
  },
  async testCredential({ id }) {
    return testCredential(String(id ?? ""));
  },
  async removeCredential({ id }) {
    // Where it was still used comes back with the list: those entries are passed over from now on.
    const { usedIn } = await removeCredential(String(id ?? ""), defaultOrder());
    return { ...(await listCredentials({ order: defaultOrder() })), ...(usedIn.length ? { usedIn } : {}) };
  },
  async credentialAction({ id, action, args }) {
    const result = await credentialAction(String(id ?? ""), String(action ?? ""), args);
    // A status poll (a sign-in's signInStatus every 2 s) answers the last list: no discovery.
    const last = isStatusAction(String(id ?? ""), String(action ?? "")) ? lastCredentialList() : undefined;
    return { result, list: last ?? (await listCredentials({ order: defaultOrder() })) };
  },

  async listCommands({ sessionId }) {
    const s = await runningLive(sessionId);
    if (s) return s.slashMenu();
    // Not running: the skills, and the commands its harness reported when it last ran.
    return storedSlashMenu(parseId(sessionId).harness, await sessionPath(sessionId));
  },

  // ---- master context (runner/src/context) ----

  async contextStatus() {
    return context.status();
  },
  async listMemories({ scope, query }) {
    return context.listMemories(scope && /^[~/]/.test(scope) ? expand(scope) : scope, query);
  },
  async getMemory({ id }) {
    return context.getMemory(id);
  },
  async editMemory({ id, ...change }) {
    return context.editMemory(id, change);
  },
  async memoryHistory({ id }) {
    return context.history(id);
  },
  async contextActivity({ limit, before }) {
    return context.activity(limit, before);
  },
  async listConflicts({ status }) {
    return context.conflicts(status);
  },
  async resolveConflict({ id, action }) {
    return context.resolveConflict(id, action);
  },
  async listSkills() {
    return context.listSkills();
  },
  async setSkillEnabled({ name, enabled }) {
    return context.setSkillEnabled(name, enabled);
  },
  async contextImportPreview() {
    return context.preview();
  },
  async contextImport() {
    return context.runImport();
  },
  async getBackgroundModel() {
    return context.backgroundModel();
  },
  async setBackgroundModel({ model }) {
    return context.setBackgroundModel(model);
  },
  async setJudgeEnabled({ enabled }) {
    return context.setJudgeEnabled(enabled);
  },
  async contextDisable() {
    return context.disable();
  },
  async harnessCapabilities() {
    return capabilityMatrix();
  },

  // ---- MCP registry (runner/src/mcp) ----

  async listMcpServers() {
    return listMcpServers();
  },
  async addMcpServer({ text, name, scope }) {
    return addMcpServers(text, { name, scope: scope && /^[~/]/.test(scope) ? expand(scope) : scope });
  },
  async setMcpServer({ id, ...change }) {
    return setMcpServer(id, change);
  },
  async findMcpServers() {
    const { export: _, ...r } = await importMcpServers((await allProjects()).map((p) => p.path));
    return r;
  },

  // ---- hooks (runner/src/hooks.ts) ----

  async listHooks() {
    return listHooks();
  },
  async addHooks({ text }) {
    return addHooks(text);
  },
  async setHook({ id, ...change }) {
    return setHook(id, change);
  },
  async findHooks() {
    return importHooks();
  },

  // ---- your commands, subagents and secrets (commands.ts, subagents.ts, secrets.ts) ----

  async listLibraryCommands() {
    return listLibraryCommands();
  },
  async addLibraryCommand({ name, text, style }) {
    return addLibraryCommand(name, text, style);
  },
  async setLibraryCommand({ id, ...change }) {
    return setLibraryCommand(id, change);
  },
  async findLibraryCommands() {
    return importCommands();
  },
  async listSubagents() {
    return listSubagents();
  },
  async addSubagent({ text, name }) {
    return addSubagent(text, name);
  },
  async setSubagent({ id, ...change }) {
    return setSubagent(id, change);
  },
  async findSubagents() {
    return importSubagents();
  },
  async listSecrets() {
    return listSecrets();
  },
  async setSecret({ name, ...change }) {
    return setSecret(name, change);
  },
  // OAuth sign-in (runner/src/mcp/oauth.ts): the app's /api/mcp-oauth/callback relays finishMcpAuth.
  async startMcpAuth({ id, redirectUri, clientId, clientSecret }) {
    return startServerAuth(id, { runnerId: config().runnerId, redirectUri, clientId, clientSecret });
  },
  async finishMcpAuth(p) {
    return finishServerAuth(p);
  },
  async getUiPrefs() {
    return uiPrefs();
  },
  async setUiPrefs(prefs) {
    return setUiPrefs(prefs ?? {});
  },
  async getViewed() {
    return viewedMap();
  },
  async markViewed({ sessionId, projectPath }) {
    if (typeof sessionId !== "string" || !sessionId) throw new Error("sessionId is required");
    const at = markViewed(sessionId, live.get(sessionId)?.projectPath ?? (typeof projectPath === "string" && projectPath ? projectPath : undefined));
    // Every browser merges just this one; Home's pulse (if it has one) says it too.
    send({ t: "viewed", sessionId, viewedAt: at });
    pulses.touch(sessionId);
    return { viewedAt: at };
  },
  async listRecent({ days }) {
    const d = typeof days === "number" && days >= 0 ? days : 3;
    // Several browsers load at once (a reconnect): one scan serves them all for a few seconds.
    const hit = recentCache.get(d);
    if (hit && Date.now() - hit.at < 10_000) return hit.list;
    const list = (async () => {
      const projects = recentProjects(await allProjects(), allViewed(), d);
      const sessions = (await Promise.all(projects.map((p) => projectSessions(p.path).catch(() => [])))).flat();
      return pickRecent(sessions, d);
    })();
    recentCache.set(d, { at: Date.now(), list });
    list.catch(() => recentCache.delete(d));
    return list;
  },
};

// ---------------- main ----------------

process.on("unhandledRejection", (e) => console.error("unhandled:", e));
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    // Record what each session was doing before closing anything, then keep it: resumeActive()
    // on the next start picks these sessions back up.
    for (const s of live.values()) if (!s.closed) s.savePrefs();
    freezeConfig();
    saveViewed();
    console.log(`stopping (${sig}); ${[...live.values()].filter((s) => !s.closed && s.busy).length} busy session(s) will resume on restart`);
    // Subagents closing now aren't stopped: they resume too, and their parents hear nothing.
    agents.shutdown();
    for (const s of live.values()) s.close();
    setTimeout(() => process.exit(0), 500);
  });

console.log(`Tether runner ${VERSION} (${config().runnerId}) → ${URL_BASE}`);
// Bridge tokens of the last run are dead (a new secret): their session files go before any session starts.
sweepBridgeFiles();
connect();
scanProjects();
context.start();
// A second runner on the same machine (tests, dev) must never take over live sessions.
const resumed = process.env.TETHER_NO_RESUME ? Promise.resolve() : resumeActive(getLive);
// Loops and schedules (/loop, /schedule): one timer for every session's runs, started once the
// resumed sessions are open. With TETHER_NO_RESUME only sessions this runner has open run theirs.
void resumed.finally(() =>
  setScheduler(
    sessionScheduler({
      live: () => live.values(),
      stored: () => config().sessions,
      archived: () => config().archived,
      open: getLive,
      save: saveConfig,
      openClosed: !process.env.TETHER_NO_RESUME,
    }),
  ),
);

// Attachments of sessions removed or marked done a while ago, and abandoned uploads.
function sweep() {
  try {
    sweepUploads();
    const referenced = [...live.values()].flatMap((s) => s.attachmentFolders());
    const removed = sweepAttachments({ archived: config().archived, live: [...live.keys()], referenced });
    if (removed.length) console.log(`removed attachments of ${removed.length} old session(s)`);
  } catch (e: any) {
    console.error(`attachment cleanup failed: ${e?.message ?? e}`);
  }
}
setTimeout(sweep, 60_000);
setInterval(sweep, 6 * 60 * 60_000);
setInterval(() => sweepUploads(), 5 * 60_000);
