// Tether runner: runs coding agents on this machine and serves them to the Tether app.
// It dials out to the app (TETHER_URL) with an app service token (TETHER_TOKEN), so the
// machine needs no inbound port.

import { existsSync, statSync } from "node:fs";
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
  SessionSummary,
} from "../../web/src/shared/protocol";
import { kiroAdapter, opencodeAdapter } from "./adapters/acp";
import { agyHookInstalled, antigravityAdapter } from "./adapters/antigravity";
import { claudeAdapter } from "./adapters/claude";
import { codexAdapter } from "./adapters/codex";
import { piAdapter } from "./adapters/pi";
import type { Adapter, Sink } from "./adapters/types";
import { availableProfiles, config, freezeConfig, prefs, saveConfig, setUiPrefs, uiPrefs } from "./config";
import { buildBrief } from "./handoff";
import { getUsage } from "./usage";
import { ConflictNotifier, forgetSession, notifyConflicts, recent, sendTest, subscribe, subscription, unsubscribe, vapidPublicKey } from "./notify";
import { APPROVING_MODES, byRecent, isActive, type ChainEntry, type SessionActivity } from "../../web/src/shared/protocol";
import { cleanProfiles, profileProblems } from "../../web/src/shared/profiles";
import type { LiveSession } from "./session";
import { ContextService } from "./context";
import { resolveForBrief, useContextSkills } from "./skillcmd";
import { displayText } from "../../web/src/shared/skill";
import { carriedNotice } from "./context/handoff";
import { untilde } from "./context/paths";
import { sessionForKey } from "./bridge";
import { buildPulse, ClosedPulses, PulseThrottle, TurnClock } from "./pulse";
import { checkAttachments, discard, readChunk, receiveChunk, sweepAttachments, sweepUploads } from "./attachments";
import { withAttachments } from "../../web/src/shared/attachments";

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
const live = new Map<string, LiveSession>();
// Master context: inert until the first import is run from the UI (contextImport).
const context = new ContextService({
  emit: (event) => send({ t: "context", event }),
  sessionForKey: (key) => sessionForKey(key)?.id,
  projects: () => config().projects,
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

/** Applies runner-side overrides (archive, user title) to a summary. */
function decorate(s: SessionSummary): SessionSummary {
  const cfg = config();
  const title = cfg.titles[s.id];
  return { ...s, ...(title ? { title } : {}), ...(cfg.archived.includes(s.id) ? { archived: true } : {}) };
}

// ---------------- dashboard pulses ----------------

const turns = new TurnClock();
// Per-session pulse state lives as long as the session is live or among the recently finished.
const closedPulses = new ClosedPulses(20, (id) => {
  if (live.has(id)) return;
  turns.forget(id);
  pulses.forget(id);
});

function pulseOf(id: string) {
  const s = live.get(id);
  if (!s) return closedPulses.get(id);
  return buildPulse({ session: decorate(s.summary()), state: s.t.state, messages: s.t.messages, turnStartedAt: turns.turnStartedAt(id), finishedAt: turns.finishedAt(id) });
}

const pulses = new PulseThrottle({
  build: pulseOf,
  // Only while connected: after a reconnect browsers reload the list, and changes send afresh (resetSent).
  send: (list) => connected && send({ t: "pulse", pulses: list }),
});

const sink: Sink = {
  emit: (sessionId: string, seq: number, event: SessionEvent) => {
    send({ t: "event", sessionId, seq, event });
    if (event.type === "state" && event.state.status) turns.update(sessionId, event.state.status);
    pulses.touch(sessionId);
  },
  summary: (s: SessionSummary) => {
    send({ t: "sessions", projectPath: s.projectPath, session: decorate(s) });
    if (live.has(s.id)) pulses.touch(s.id);
  },
  handoff: (from, to, reason, pendingPrompt) => handoff(from, to, reason, pendingPrompt),
};

/**
 * Cross-harness fallback: a new session in `to.harness`, same directory, seeded with a brief of
 * the conversation so far. The two sessions are linked both ways, and browsers on the old one
 * follow the link.
 */
async function handoff(from: LiveSession, to: ChainEntry, reason: string, pendingPrompt?: string) {
  const a = adapters[to.harness];
  // The prompt comes as typed: `/skill args` is resolved for the new harness, not the old one.
  const prompt = pendingPrompt === undefined ? undefined : resolveForBrief(to.harness, from.projectPath, pendingPrompt);
  // Master context on: carry the relevant memories and capture what this session learned first.
  const memory = await context.handoffMemory({
    sessionId: from.id,
    projectPath: from.projectPath,
    messages: from.t.messages,
    target: to.harness,
    pendingPrompt: pendingPrompt && displayText(pendingPrompt),
  });
  const brief = await buildBrief({
    messages: from.t.messages,
    cwd: from.projectPath,
    fromLabel: `${from.harness}, ${from.t.state.model ?? "default model"}`,
    reason,
    pendingPrompt: prompt,
    memory: memory?.text,
  });
  const mode = from.t.state.permissionMode;
  const next = a.create(from.projectPath, { model: to.model, permissionMode: mode && !APPROVING_MODES.has(mode) ? mode : undefined }, sink);
  next.t.state.guard = from.guardMode;
  try {
    await next.start();
  } finally {
    memory?.settle?.(); // captured facts go to the merge pass only now: next's injection is fixed
  }
  track(next);
  next.inheritDiffBase(from.diffBase);
  // The brief lists the earlier session's attachments: the new agent may read them too.
  next.inheritedAttachments = from.attachmentFolders();
  next.setTitle(from.title);
  next.setState({
    chain: from.t.state.chain,
    profile: from.t.state.profile,
    preferEarlier: from.t.state.preferEarlier,
    handoffFrom: { sessionId: from.id, reason },
    guard: from.guardMode,
  });
  if (to.model !== "default" && next.t.state.model !== to.model) await next.applyModel(to.model);
  from.setState({ status: "idle", waitingReason: undefined, waitingUntil: undefined, handoffTo: { sessionId: next.id, reason } });
  from.notice(`${reason}. Continued in ${to.harness} · ${to.model}.`, "warning");
  const carried = (memory?.carried.length ?? 0) + (memory?.captured.length ?? 0);
  if (memory && (carried || memory.native)) {
    const what = carried ? `${carried} ${carried === 1 ? "memory" : "memories"}` : "the shared memory";
    next.notice(
      `The agent was given the conversation, the repository state and ${what}.\n\n${carriedNotice(memory, to.harness)}`,
      "info",
      { title: `Continued from a ${from.harness} session: ${reason}. Carried ${what}.`, collapsed: true, source: "memory" },
    );
  } else next.notice(`Continued from a ${from.harness} session: ${reason}. The agent was given the conversation and the repository state.`, "info");
  if (prompt) next.addUserMessage(prompt);
  // Messages still waiting on the old session move over and wait on the new one.
  const carry = from.t.state.pending ?? [];
  if (carry.length) from.setState({ pending: [], pendingHeld: undefined });
  await next.continueTurn(brief);
  if (carry.length) next.setState({ pending: carry });
  sink.summary(next.summary());
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
    const harnesses = (await Promise.all(Object.values(adapters).map(async (a) => ((await a.available()) ? a.id : null)))).filter(Boolean) as HarnessId[];
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

async function getLive(sessionId: string, projectPath?: string): Promise<LiveSession> {
  const existing = live.get(sessionId);
  if (existing && !existing.closed) return existing;
  const { harness, nativeId } = parseId(sessionId);
  let path = projectPath;
  if (!path) {
    for (const p of await allProjects()) {
      if ((await adapters[harness].listSessions(p.path)).some((s) => s.nativeId === nativeId)) {
        path = p.path;
        break;
      }
    }
  }
  if (!path) throw new Error(`session ${sessionId} not found`);
  // Read before starting: a starting session saves its (default) model over these.
  const saved = config().sessions[sessionId];
  const choices = saved && { model: saved.model, thinking: saved.thinking, permissionMode: saved.permissionMode };
  const s = await adapters[harness].resume(nativeId, path, sink);
  await s.start();
  track(s);
  await s.reapplyChoices(choices);
  return s;
}

function requireLive(sessionId: string): LiveSession {
  const s = live.get(sessionId);
  if (!s || s.closed) throw new Error("Session is not running. Open it again.");
  return s;
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
  for (const s of live.values()) if (!s.closed) by.get(s.projectPath)?.live.push(decorate(s.summary()));
  return [...by.values()]
    .filter((p) => existsSync(p.path))
    .map((p) => (cfg.hidden.includes(p.path) ? { ...p, archived: true } : p))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

function expand(path: string) {
  return resolve(untilde(path)); // $HOME, like every context path (context/paths.ts)
}

async function projectSessions(projectPath: string): Promise<SessionSummary[]> {
  const stored = (await Promise.all(Object.values(adapters).map((a) => a.listSessions(projectPath).catch(() => [])))).flat();
  const out = new Map(stored.map((s) => [s.id, s]));
  for (const s of live.values()) if (s.projectPath === projectPath && !s.closed) out.set(s.id, s.summary());
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

type Handlers = { [K in OpName]: (args: Ops[K]["args"]) => Promise<Ops[K]["result"]> };

const ops: Handlers = {
  async listProjects() {
    return allProjects();
  },

  async addProject({ path }) {
    const p = expand(path);
    if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error(`${p} is not a directory`);
    const cfg = config();
    if (!cfg.projects.includes(p)) cfg.projects.push(p);
    cfg.hidden = cfg.hidden.filter((h) => h !== p);
    saveConfig();
    return (await allProjects()).find((x) => x.path === p)!;
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
    const entries = await readdir(p, { withFileTypes: true });
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

  async createSession({ projectPath, harness, model, profile, prompt, permissionMode, guard }) {
    const a = adapters[harness];
    if (!a) throw new Error(`unknown harness ${harness}`);
    const s = a.create(expand(projectPath), { model: profile ? undefined : model, permissionMode: permissionMode && !APPROVING_MODES.has(permissionMode) ? permissionMode : undefined }, sink);
    // Set before start() so harnesses that take it as a launch flag (Antigravity) see it.
    s.t.state.guard = guard ?? config().guard?.defaultMode ?? "auto";
    await s.start();
    track(s);
    s.setState({ guard: s.t.state.guard });
    if (profile) await s.setModelOrProfile(undefined, profile);
    if (prompt) await s.prompt(prompt);
    sink.summary(s.summary());
    return s.summary();
  },

  async openSession({ sessionId, projectPath }) {
    return (await getLive(sessionId, projectPath)).snapshot();
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
      const s = live.get(sessionId);
      if (s && s.t.state.status === "idle") s.close();
    }
    saveConfig();
    return {};
  },

  async removeSession({ sessionId }) {
    const cfg = config();
    // Archived first, so the closing summary already carries it.
    if (!cfg.archived.includes(sessionId)) cfg.archived.push(sessionId);
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
    if (p) Object.assign(p, { active: false, pending: undefined, background: undefined });
    forgetSession(sessionId);
    saveConfig();
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
      sink.summary(s.summary());
    }
    if (text.startsWith("!")) {
      const command = text.slice(1).trim();
      if (command) void s.runShell(command).catch((e) => s.notice(`Shell command failed: ${e?.message ?? e}`, "error"));
      return {};
    }
    await s.prompt(s.withShellContext(text), mode);
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
    await requireLive(sessionId).stop();
    return {};
  },

  async editPending({ sessionId, id, ...change }) {
    await requireLive(sessionId).editPending(id, change);
    return {};
  },

  async takePending({ sessionId }) {
    return { text: requireLive(sessionId).takePending() };
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

  async amendSteer({ sessionId, msgId, text }) {
    requireLive(sessionId).amendSteer(msgId, text);
    return {};
  },

  async setModel({ sessionId, model, profile }) {
    await requireLive(sessionId).setModelOrProfile(model, profile);
    return {};
  },

  async setGuard({ sessionId, mode }) {
    requireLive(sessionId).setGuard(mode);
    return {};
  },

  async getSessionDiff({ sessionId, checkpoint }) {
    return (await getLive(sessionId)).diff(checkpoint);
  },

  async checkPaths({ sessionId, paths }) {
    if (!Array.isArray(paths)) throw new Error("paths must be a list");
    return (await getLive(sessionId)).checkPaths(paths);
  },

  async fileDiff({ sessionId, path, checkpoint, reveal }) {
    return (await getLive(sessionId)).fileDiff(String(path ?? ""), typeof checkpoint === "string" ? checkpoint : undefined, reveal === true);
  },

  async readFile({ sessionId, path, maxBytes, reveal }) {
    return (await getLive(sessionId)).readFile(String(path ?? ""), maxBytes, reveal === true);
  },

  async approveBlocked({ sessionId, toolId }) {
    await (await getLive(sessionId)).approveBlocked(toolId);
    return {};
  },

  async stopActivity({ sessionId, id }) {
    await requireLive(sessionId).stopActivity(id);
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
    return out.filter((p) => !p.session.archived);
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
    await requireLive(sessionId).setChain(chain, preferEarlier, undefined);
    return {};
  },

  async setThinking({ sessionId, level }) {
    await requireLive(sessionId).setThinking(level);
    return {};
  },

  async setPermissionMode({ sessionId, mode }) {
    // The picker never offers these; refuse them here too so no client can skip the guard.
    if (APPROVING_MODES.has(mode)) throw new Error(`${mode} approves tool calls without the guard; use the guard setting instead.`);
    await requireLive(sessionId).setPermissionMode(mode);
    return {};
  },

  async uiRespond({ sessionId, response }) {
    // stale: no such request is waiting (answered elsewhere, timed out, cancelled by a stop)
    return requireLive(sessionId).uiRespond(response) ? {} : { stale: true };
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
    return adapters[harness].listModels(s);
  },

  async getProfiles() {
    return availableProfiles();
  },

  async setProfiles({ profiles }) {
    // Reject rather than silently drop a profile the UI let through (an older web app, say).
    const problems = profileProblems(profiles);
    const bad = problems.findIndex(Boolean);
    if (bad >= 0) throw new Error(`Profile ${profiles[bad]!.name.trim() ? `“${profiles[bad]!.name.trim()}”` : bad + 1}: ${problems[bad]}. Nothing was saved.`);
    const clean = cleanProfiles(profiles);
    config().profiles = clean;
    saveConfig();
    return clean;
  },

  async listCommands({ sessionId }) {
    return requireLive(sessionId).slashMenu();
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
  async getUiPrefs() {
    return uiPrefs();
  },
  async setUiPrefs(prefs) {
    return setUiPrefs(prefs ?? {});
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
    console.log(`stopping (${sig}); ${[...live.values()].filter((s) => !s.closed && s.busy).length} busy session(s) will resume on restart`);
    for (const s of live.values()) s.close();
    setTimeout(() => process.exit(0), 500);
  });

/**
 * Turns that were running when the runner last stopped are resumed, and messages the agent had
 * not taken yet are sent again, so a restart never strands an agent or loses what you typed.
 */
async function resumeActive() {
  // Copy what was saved now: opening a session re-saves its prefs (as idle), overwriting these.
  const saved = Object.entries(config().sessions).map(([id, p]) => [id, structuredClone(p)] as const);
  for (const [id, p] of saved) {
    const unsent = p.pending ?? [];
    if (!p.active && !unsent.length) continue;
    try {
      const s = await getLive(id, p.projectPath);
      if (p.active) {
        const bg = p.background ?? [];
        const parts = ["The runner restarted while this session was working. Resuming."];
        if (bg.length) parts.push(`Stopped background work: ${bg.map((b) => b.description).join("; ")}.`);
        if (unsent.length) parts.push(`Resending ${unsent.length} message${unsent.length > 1 ? "s" : ""} it had not received.`);
        s.notice(parts.join(" "), "warning");
        await s.continueTurn(
          bg.length
            ? `The session was interrupted by a restart, which also stopped these background tasks: ${bg
                .map((b) => `"${b.description}"${b.type ? ` (${b.type})` : ""}`)
                .join(", ")}. Check what they had finished, restart the ones still needed, and continue where you left off.`
            : "The session was interrupted by a restart. Continue where you left off.",
        );
      }
      for (const m of unsent) await s.prompt(m.text, m.mode);
      console.log(`resumed ${id}${unsent.length ? ` (resent ${unsent.length})` : ""}`);
    } catch (e: any) {
      console.error(`could not resume ${id}: ${e?.message ?? e}`);
      prefs(id).active = false;
      saveConfig();
    }
  }
}

console.log(`Tether runner ${VERSION} (${config().runnerId}) → ${URL_BASE}`);
connect();
scanProjects();
context.start();
// A second runner on the same machine (tests, dev) must never take over live sessions.
if (!process.env.TETHER_NO_RESUME) resumeActive();

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
