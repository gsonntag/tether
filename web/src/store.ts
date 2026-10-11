import { create } from "zustand";
import type {
  AgentNotice,
  ContextActivity,
  ContextEvent,
  ContextStatus,
  MemoryConflict,
  OpName,
  Ops,
  ProjectInfo,
  RunnerInfo,
  ServerToBrowser,
  SessionEvent,
  SessionPulse,
  SessionSnapshot,
  SessionSummary,
  UsageReport,
} from "./shared/protocol";
import { byRecent } from "./shared/protocol";
import { mergePulses, type PulseMap } from "./dashboard";
import { dropCached, getCached, putCached } from "./cache";
import { applyEvent, type Transcript } from "./shared/reducer";

export interface OpenSession extends Transcript {
  session: SessionSummary;
  seq: number;
  loading: boolean;
  /** showing a saved or pre-reconnect copy while the runner sends a fresh snapshot */
  syncing?: boolean;
}

export interface Toast {
  id: number;
  level: "info" | "warning" | "error";
  text: string;
}

interface State {
  connected: boolean;
  user?: { name: string; email: string };
  runners: RunnerInfo[];
  runnerId?: string;
  projects: ProjectInfo[];
  projectsLoaded: boolean;
  sessions: Record<string, SessionSummary[]>; // projectPath -> sessions
  expanded: Record<string, boolean>;
  open: Record<string, OpenSession>; // sessionId -> transcript
  selected?: string; // sessionId
  toasts: Toast[];
  /** the mobile drawer */
  sidebarOpen: boolean;
  /** desktop: sidebar collapsed to focus on one session */
  sidebarHidden: boolean;
  /** the session's Activity panel (side panel on desktop, sheet on phones) */
  activityOpen: boolean;
  dialog?: "new" | "addProject" | "settings" | "notify";
  newSessionProject?: string;
  usage?: UsageReport;
  /** recent notifications from the runner (newest first), for the bell */
  notices: AgentNotice[];
  /** newest notification already looked at */
  noticesSeen: number;
  /** individual notices opened on this device */
  noticesRead: string[];
  /** a full page shown instead of a session ("running": Home, scrolled to its Running section) */
  page?: "memory" | "running";
  /** Home dashboard: every connected runner's sessions at a glance (runnerId -> sessionId -> pulse) */
  pulses: PulseMap;
  /** the Memory & Skills tab to switch to (set by links into the page) */
  memoryTab?: "memory" | "activity" | "conflicts" | "skills";
  /** master context (shared memory and skills) */
  contextStatus?: ContextStatus;
  /** memory conflicts nobody has resolved yet, newest first */
  conflicts: MemoryConflict[];
  /** activity that arrived while this tab was open, newest first */
  contextLive: ContextActivity[];
}

export const useStore = create<State>(() => ({
  connected: false,
  runners: [],
  projects: [],
  projectsLoaded: false,
  sessions: {},
  expanded: loadJSON("tether.expanded", {}),
  open: {},
  toasts: [],
  sidebarOpen: false,
  sidebarHidden: loadJSON("tether.sidebarHidden", false),
  // Phones start closed: there it's a sheet over the session.
  activityOpen: !window.matchMedia("(max-width: 767px)").matches && loadJSON("tether.activityOpen", false),
  notices: [],
  noticesSeen: loadJSON("tether.noticesSeen", 0),
  noticesRead: loadJSON("tether.noticesRead", []),
  conflicts: [],
  contextLive: [],
  pulses: {},
}));

const set = useStore.setState;
const get = useStore.getState;

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
export function saveJSON(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
}

// ---------------- connection ----------------

let ws: WebSocket | undefined;
let rpcN = 0;
const waits = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let toastN = 0;

export function toast(level: Toast["level"], text: string) {
  const t = { id: ++toastN, level, text };
  set((s) => ({ toasts: [...s.toasts.slice(-3), t] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) })), level === "error" ? 9000 : 5000);
}

export function rpc<K extends OpName>(op: K, args: Ops[K]["args"]): Promise<Ops[K]["result"]> {
  return rpcTo(get().runnerId, op, args);
}

/** rpc() to a given runner, not necessarily the one the sidebar shows (the Home dashboard spans them all). */
export function rpcTo<K extends OpName>(runnerId: string | undefined, op: K, args: Ops[K]["args"]): Promise<Ops[K]["result"]> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error("Not connected"));
    if (!runnerId) return reject(new Error("No runner is connected"));
    const id = `b${++rpcN}`;
    waits.set(id, { resolve, reject });
    ws.send(JSON.stringify({ t: "rpc", id, runnerId, op, args }));
  });
}

/** rpc() that reports failures as a toast. */
export async function act<K extends OpName>(op: K, args: Ops[K]["args"]): Promise<Ops[K]["result"] | undefined> {
  try {
    return await rpc(op, args);
  } catch (e: any) {
    toast("error", e.message ?? String(e));
    return undefined;
  }
}

export function connect(attempt = 0) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const sock = new WebSocket(`${proto}//${location.host}/api/ws`);
  ws = sock;
  let pinger: ReturnType<typeof setInterval>;
  sock.onopen = () => {
    attempt = 0;
    set({ connected: true });
    pinger = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify({ t: "ping" })), 25_000);
  };
  sock.onmessage = (e) => onMessage(JSON.parse(String(e.data)));
  sock.onclose = () => {
    clearInterval(pinger);
    if (ws !== sock) return;
    set({ connected: false });
    markSyncing();
    for (const w of waits.values()) w.reject(new Error("Connection lost"));
    waits.clear();
    retry = setTimeout(() => connect(attempt + 1), Math.min(15_000, 500 * 2 ** attempt));
  };
}
let retry: ReturnType<typeof setTimeout> | undefined;

// Reconnect immediately when a phone wakes the tab, or the device comes back online (instead of
// waiting out the backoff). Drops the pending retry so it doesn't open a second socket.
const reconnectNow = () => {
  if (!ws || ws.readyState <= WebSocket.OPEN) return;
  clearTimeout(retry);
  connect();
};
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && reconnectNow());
window.addEventListener("online", reconnectNow);

function onMessage(m: ServerToBrowser) {
  switch (m.t) {
    case "hello":
      set({ user: m.user });
      break;
    case "runners": {
      const prev = get().runnerId;
      const online = m.runners.filter((r) => r.connected);
      const keep = online.find((r) => r.id === prev) ?? online.find((r) => r.id === loadJSON("tether.runner", "")) ?? online[0];
      set((s) => ({ runners: m.runners, runnerId: keep?.id, pulses: Object.fromEntries(Object.entries(s.pulses).filter(([id]) => online.some((r) => r.id === id))) }));
      for (const r of online) refreshPulses(r.id);
      if (keep) {
        saveJSON("tether.runner", keep.id);
        refreshProjects();
        refreshUsage();
        refreshNotices();
        refreshContext();
        // Re-sync open transcripts (events may have been missed while the runner was away).
        loads.clear();
        for (const id of Object.keys(get().open)) loadSession(id);
      } else markSyncing();
      break;
    }
    case "result": {
      const w = waits.get(m.id);
      if (!w) return;
      waits.delete(m.id);
      m.ok ? w.resolve(m.data) : w.reject(new Error(m.error ?? "failed"));
      break;
    }
    case "event":
      if (m.runnerId === get().runnerId) onEvent(m.sessionId, m.seq, m.event);
      break;
    case "sessions":
      // Notifications follow session changes (finished, needs input), so look for new ones.
      if (m.runnerId === get().runnerId) refreshNoticesSoon();
      if (m.runnerId === get().runnerId && m.session) upsertSummary(m.session);
      else if (m.runnerId === get().runnerId && m.projectPath) refreshSessions(m.projectPath);
      break;
    case "context":
      if (m.runnerId === get().runnerId) onContextEvent(m.event);
      break;
    case "pulse":
      set((s) => ({ pulses: mergePulses(s.pulses, m.runnerId, m.pulses) }));
      break;
  }
}

// ---------------- Home dashboard ----------------

/** The runner's full list (live sessions and recently finished ones); pushes keep it current after. */
export async function refreshPulses(runnerId: string) {
  try {
    const list: SessionPulse[] = await rpcTo(runnerId, "listPulses", {});
    set((s) => ({ pulses: { ...s.pulses, [runnerId]: mergePulses({}, runnerId, list)[runnerId] ?? {} } }));
  } catch {
    // An older runner has no pulses: its sessions just don't show on Home.
  }
}

/** Drops a pulse here at once (an approval answered, a session removed) without waiting for the runner. */
export function patchPulse(runnerId: string, sessionId: string, patch: (p: SessionPulse) => SessionPulse | undefined) {
  set((s) => {
    const cur = s.pulses[runnerId]?.[sessionId];
    if (!cur) return {};
    const next = patch(cur);
    const forRunner = { ...s.pulses[runnerId] };
    if (next) forRunner[sessionId] = next;
    else delete forRunner[sessionId];
    return { pulses: { ...s.pulses, [runnerId]: forRunner } };
  });
}

/** Opens a session from Home, switching the sidebar to its runner first when needed. */
export function openOnRunner(runnerId: string, session: SessionSummary, opts: { activity?: boolean } = {}) {
  if (runnerId !== get().runnerId) switchRunner(runnerId);
  // With its summary known, opening it doesn't have to search every project for it.
  set((s) => ({
    sessions: { ...s.sessions, [session.projectPath]: [...(s.sessions[session.projectPath] ?? []).filter((x) => x.id !== session.id), session] },
  }));
  selectSession(session.id);
  if (opts.activity) setActivityOpen(true);
}

/** Home: the dashboard (no session, no page). */
export function goHome() {
  set({ selected: undefined, page: undefined, sidebarOpen: false });
  history.replaceState(null, "", "#/");
}

function onEvent(sessionId: string, seq: number, event: SessionEvent) {
  if (event.type === "toast" && get().selected === sessionId) toast(event.level, event.text);
  const cur = get().open[sessionId];
  if (!cur || cur.loading || cur.syncing) return; // the coming snapshot includes it
  if (seq <= cur.seq) return;
  if (seq !== cur.seq + 1) {
    loadSession(sessionId); // gap: resync
    return;
  }
  const next: OpenSession = { ...cur, messages: [...cur.messages], state: { ...cur.state }, seq };
  // applyEvent patches parts in place; give the touched message new objects so memoized rows re-render.
  if (event.type === "tool" || event.type === "delta") {
    let i = next.messages.length - 1;
    while (i >= 0 && next.messages[i]!.id !== event.msgId) i--;
    if (i >= 0) next.messages[i] = { ...next.messages[i]!, parts: next.messages[i]!.parts.map((p) => ({ ...p })) };
  }
  applyEvent(next, event);
  if (event.type === "state" && event.state.status) next.session = { ...next.session, status: event.state.status };
  set((s) => ({ open: { ...s.open, [sessionId]: next } }));
  saveSoon(sessionId);
  if (event.type === "state") attention(next, event.state);
}

function upsertSummary(sum: SessionSummary) {
  set((s) => {
    const list = s.sessions[sum.projectPath] ?? [];
    const i = list.findIndex((x) => x.id === sum.id);
    // A turn just ended: usage moved (the runner has marked its cache stale).
    if (i >= 0 && list[i]!.status !== "idle" && sum.status === "idle") setTimeout(() => ((usageAt = 0), refreshUsage()), 2000);
    const next = i >= 0 ? list.map((x) => (x.id === sum.id ? sum : x)) : [sum, ...list];
    next.sort(byRecent);
    const open = s.open[sum.id] ? { ...s.open, [sum.id]: { ...s.open[sum.id]!, session: sum } } : s.open;
    const knownProject = s.projects.some((p) => p.path === sum.projectPath);
    if (!knownProject) refreshProjects();
    return { sessions: { ...s.sessions, [sum.projectPath]: next }, open };
  });
}

// ---------------- data loading ----------------

// ---------------- plan usage (5h / weekly limits) ----------------

let usageAt = 0;
export async function refreshUsage(force = false) {
  if (!get().runnerId || (!force && Date.now() - usageAt < 60_000)) return;
  usageAt = Date.now();
  try {
    set({ usage: await rpc("getUsage", { force }) });
  } catch {
    usageAt = 0;
  }
}
setInterval(() => document.visibilityState === "visible" && refreshUsage(), 120_000);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refreshUsage());

export async function refreshProjects() {
  const projects = await rpc("listProjects", {}).catch(() => undefined);
  if (!projects) return;
  set({ projects, projectsLoaded: true });
  const exp = get().expanded;
  const sel = get().open[get().selected ?? ""]?.session?.projectPath;
  for (const p of projects) if (exp[p.path] || p.path === sel) refreshSessions(p.path);
}

export async function refreshSessions(projectPath: string) {
  const list = await rpc("listSessions", { projectPath }).catch(() => undefined);
  if (list) set((s) => ({ sessions: { ...s.sessions, [projectPath]: list } }));
}

export function toggleProject(path: string, open?: boolean) {
  const expanded = { ...get().expanded, [path]: open ?? !get().expanded[path] };
  set({ expanded });
  saveJSON("tether.expanded", expanded);
  if (expanded[path]) refreshSessions(path);
}

function runnerKey() {
  return get().runnerId ?? loadJSON<string>("tether.runner", "");
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
function saveSoon(sessionId: string) {
  if (saveTimers.has(sessionId)) return;
  saveTimers.set(
    sessionId,
    setTimeout(() => {
      saveTimers.delete(sessionId);
      const o = get().open[sessionId];
      if (o && !o.loading && !o.syncing) putCached(runnerKey(), { session: o.session, messages: o.messages, state: o.state, seq: o.seq });
    }, 3000),
  );
}

/** Connection to the runner lost: what's on screen may be falling behind. */
function markSyncing() {
  set((s) => ({ open: Object.fromEntries(Object.entries(s.open).map(([id, o]) => [id, o.loading ? o : { ...o, syncing: true }])) }));
}

const loads = new Map<string, Promise<void>>();
/** Shows what we already have (on screen or saved in the browser) at once, then swaps in the runner's snapshot. */
export function loadSession(sessionId: string) {
  let p = loads.get(sessionId);
  if (!p) {
    p = doLoad(sessionId).finally(() => loads.delete(sessionId));
    loads.set(sessionId, p);
  }
  return p;
}

async function doLoad(sessionId: string) {
  const cur = get().open[sessionId];
  if (cur && !cur.loading) set((s) => ({ open: { ...s.open, [sessionId]: { ...cur, syncing: true } } }));
  else {
    set((s) => ({ open: { ...s.open, [sessionId]: { loading: true, messages: [], seq: 0 } as any } }));
    getCached(runnerKey(), sessionId).then((snap) => {
      if (snap && get().open[sessionId]?.loading) set((s) => ({ open: { ...s.open, [sessionId]: { ...snap, loading: false, syncing: true } } }));
    });
  }
  // With the project path the runner can resume directly instead of searching every project.
  const projectPath =
    get().open[sessionId]?.session?.projectPath ?? Object.values(get().sessions).flat().find((x) => x.id === sessionId)?.projectPath;
  try {
    const snap: SessionSnapshot = await rpc("openSession", { sessionId, projectPath });
    set((s) => ({ open: { ...s.open, [sessionId]: { ...snap, loading: false, syncing: false } } }));
    upsertSummary(snap.session);
    putCached(runnerKey(), snap);
  } catch (e: any) {
    // No runner yet: keep the saved copy; the runners message reloads it once one connects.
    if (!get().runnerId || !get().connected) return;
    toast("error", e.message);
    dropCached(runnerKey(), sessionId);
    set((s) => {
      const open = { ...s.open };
      delete open[sessionId];
      return { open };
    });
  }
}

// Links carry only the harness's own session id ("<harness>:" is dropped); this device remembers
// which harness each one belongs to, and otherwise the projects are searched for it.
const linkId = (sessionId: string) => sessionId.slice(sessionId.indexOf(":") + 1);

function rememberLink(sessionId: string) {
  const links = loadJSON<Record<string, string>>("tether.links", {});
  if (links[linkId(sessionId)] === sessionId) return;
  links[linkId(sessionId)] = sessionId;
  localStorage.setItem("tether.links", JSON.stringify(Object.fromEntries(Object.entries(links).slice(-500))));
}

/** Opens a session from a link: a full id, or just the harness's own id. */
export async function openLink(id: string) {
  if (id.includes(":")) return selectSession(id);
  const known = loadJSON<Record<string, string>>("tether.links", {})[id];
  if (known) return selectSession(known);
  if (!get().projectsLoaded)
    await new Promise<void>((res) => {
      const unsub = useStore.subscribe((s) => s.projectsLoaded && (unsub(), res()));
    });
  const find = () => Object.values(get().sessions).flat().find((x) => linkId(x.id) === id)?.id;
  let full = find();
  for (const p of get().projects) {
    if (full) break;
    await refreshSessions(p.path);
    full = find();
  }
  if (full) selectSession(full);
  else toast("error", "That session wasn't found on this runner.");
}

export function selectSession(sessionId: string | undefined) {
  set({ selected: sessionId, sidebarOpen: false, page: undefined });
  if (sessionId) {
    markSessionNoticeRead(sessionId);
    if (!get().open[sessionId]) loadSession(sessionId);
    rememberLink(sessionId);
    history.replaceState(null, "", `#/s/${encodeURIComponent(linkId(sessionId))}`);
  } else history.replaceState(null, "", "#/");
}

// ---------------- master context (shared memory and skills) ----------------

/** Shows the Memory & Skills page (or, with no page, the session view again). */
export function openPage(page: State["page"], tab?: State["memoryTab"]) {
  set({ page, memoryTab: tab, sidebarOpen: false, ...(page ? { selected: undefined } : {}) });
  history.replaceState(null, "", page ? `#/${page}` : "#/");
}

export async function refreshContext() {
  if (!get().runnerId) return;
  try {
    const [contextStatus, conflicts] = await Promise.all([rpc("contextStatus", {}), rpc("listConflicts", { status: "open" })]);
    set({ contextStatus, conflicts });
  } catch {
    // Older runners have no master context: the page says so.
  }
}

function onContextEvent(e: ContextEvent) {
  if (e.type === "status") set({ contextStatus: e.status });
  else if (e.type === "conflict") {
    const c = e.conflict;
    set((s) => ({ conflicts: [...(c.status === "open" ? [c] : []), ...s.conflicts.filter((x) => x.id !== c.id)] }));
  } else set((s) => ({ contextLive: [e.activity, ...s.contextLive.filter((a) => a.id !== e.activity.id)].slice(0, 300) }));
}

/** Keep new / keep old / dismiss: the conflict leaves the inbox and the session at once. */
export async function resolveConflict(id: string, action: "keep-new" | "keep-old" | "dismiss") {
  const c = await act("resolveConflict", { id, action });
  if (c) set((s) => ({ conflicts: s.conflicts.filter((x) => x.id !== id) }));
  return c;
}

// ---------------- notifications (agent finished / needs you) ----------------

export function refreshNotices() {
  if (!get().runnerId) return;
  rpc("listNotifications", {})
    .then((notices) => {
      set({ notices });
      const selected = get().selected;
      if (selected && document.visibilityState === "visible") {
        const current = notices.find((notice) => notice.sessionId === selected);
        if (current) markNoticeRead(current.id);
      }
    })
    .catch(() => {});
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function refreshNoticesSoon() {
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(refreshNotices, 1500);
}

function isNoticeRead(notice: AgentNotice) {
  return notice.ts <= get().noticesSeen || get().noticesRead.includes(notice.id);
}

export function markNoticeRead(noticeId: string) {
  const { notices, noticesRead } = get();
  const notice = notices.find((item) => item.id === noticeId);
  if (!notice || isNoticeRead(notice)) return;
  const next = [...noticesRead.filter((id) => id !== noticeId), noticeId].slice(-500);
  set({ noticesRead: next });
  saveJSON("tether.noticesRead", next);
}

export function markSessionNoticeRead(sessionId: string) {
  const notice = get().notices.find((item) => item.sessionId === sessionId);
  if (notice) markNoticeRead(notice.id);
}

export function switchRunner(id: string) {
  saveJSON("tether.runner", id);
  if (get().runnerId === id || !get().runners.some((r) => r.id === id && r.connected)) return;
  set({ runnerId: id, projects: [], sessions: {}, open: {}, selected: undefined, notices: [], contextStatus: undefined, conflicts: [], contextLive: [] });
  refreshProjects();
  refreshNotices();
  refreshContext();
}

// In-tab fallback for sessions open in this tab, when this device has no push from the runner
// (with push, the service worker shows them, tab or not).
const lastStatus = new Map<string, string>();
function attention(o: OpenSession, s: Partial<OpenSession["state"]>) {
  const id = o.session.id;
  const prev = lastStatus.get(id);
  if (s.status) lastStatus.set(id, s.status);
  if (localStorage.getItem(`tether.push.${get().runnerId}`) === "1") return;
  if (document.visibilityState === "visible" && get().selected === id) return;
  let text: string | undefined;
  if (s.status === "idle" && prev === "running") text = "Agent finished";
  if (s.pendingUi && s.pendingUi.length) text = "Agent needs your input";
  if (!text) return;
  if ("Notification" in window && Notification.permission === "granted") {
    const n = new Notification(text, { body: o.session.title, tag: id });
    n.onclick = () => {
      window.focus();
      selectSession(id);
    };
  }
}

export function setActivityOpen(open: boolean) {
  set({ activityOpen: open });
  if (!isNarrow()) saveJSON("tether.activityOpen", open);
}

/** Below Astryx's md breakpoint the sidebar is a drawer. */
export const NARROW_QUERY = "(max-width: 767px)";
export const isNarrow = () => window.matchMedia(NARROW_QUERY).matches;

/** Opens/closes the drawer on phones; collapses/expands the sidebar on wider screens. */
export function toggleSidebar() {
  if (isNarrow()) return set((s) => ({ sidebarOpen: !s.sidebarOpen }));
  const sidebarHidden = !useStore.getState().sidebarHidden;
  localStorage.setItem("tether.sidebarHidden", JSON.stringify(sidebarHidden));
  set({ sidebarHidden });
}
