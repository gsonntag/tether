// App state the shell renders: the link to the server, who is signed in, the runners, their
// session lists and projects, and the sessions this page has open.

import { create } from "zustand";
import { PROTOCOL_VERSION, type User } from "../../shared/protocol";
import { applySummary, emptySummary, type SummaryState } from "../../shared/summary";
import type { HarnessId, ModelList, ProjectInfo } from "../../shared/transcript";
import { connect, on, onAuth, onLinkState, rpc, type AuthState, type LinkState } from "./connection";
import { startPresence, tellPresence } from "./presence";
import { registerWorker, syncPush } from "./push";
import { loadKnown, mergeRunners, reconnected, saveKnown, sortRunners, type KnownRunner } from "./runners";
import { SessionModel, type SessionView, type Verdict } from "./sessionModel";
import { resubscriber, Subscriptions } from "./subscriptions";

/** Messages per `history` page closing a gap (the runner's most). */
const GAP_PAGE = 200;

const key = (runnerId: string, sessionId: string) => `${runnerId}\u0000${sessionId}`;

/** Open sessions' sync models, by runner and session. */
const models = new Map<string, { model: SessionModel; watchers: number }>();

/** The sessions this page has open; kept subscribed across every reconnect. */
export const subscriptions = new Subscriptions(
  (runnerId, sessionId) => {
    models.get(key(runnerId, sessionId))?.model.subscribing();
    return rpc(runnerId, "subscribe", { sessionId });
  },
  (runnerId, sessionId) => rpc(runnerId, "unsubscribe", { sessionId }),
);

interface State {
  link: LinkState;
  /** the link has been open at least once since the page loaded */
  everOpen: boolean;
  auth: AuthState;
  user?: User;
  /** the server speaks a newer protocol than this page: reload */
  stale: boolean;
  runners: KnownRunner[];
  /** the phone drawer */
  sidebarOpen: boolean;
  /** each runner's session list (the sidebar), kept in order by its summary epoch and seq */
  summaries: Record<string, SummaryState>;
  projects: Record<string, ProjectInfo[]>;
  /** listModels answers, by runner and harness */
  modelLists: Record<string, ModelList>;
  /** open sessions, by runner and session */
  views: Record<string, SessionView>;
  /** the new-session dialog */
  newSessionOpen: boolean;
  /** the sidebar shows only this folder's sessions */
  projectFilter?: string;
  /** the app's VAPID public key (hello); absent: the server has no push keys */
  pushKey?: string;
}

export const useStore = create<State>(() => ({
  link: "connecting",
  everOpen: false,
  auth: "ok",
  stale: false,
  runners: loadKnown(),
  sidebarOpen: false,
  summaries: {},
  projects: {},
  modelLists: {},
  views: {},
  newSessionOpen: false,
}));

const set = useStore.setState;
const get = useStore.getState;

export function start() {
  onLinkState((link) => set((s) => ({ link, everOpen: s.everOpen || link === "open" })));
  onAuth((auth) => set({ auth }));
  const resub = resubscriber(subscriptions);
  /** the next runners frame follows our own (re)connect: every runner's lists may be stale */
  let afterHello = false;
  startPresence();
  // A notification clicked while a Tether window is open: that window opens the session.
  registerWorker((url) => {
    const at = url.indexOf("#");
    if (at >= 0) location.hash = url.slice(at);
  });
  on("hello", (m) => {
    set({ user: m.user, stale: m.protocol !== PROTOCOL_VERSION, pushKey: m.push?.publicKey });
    // The server forgot what this device looked at with its old socket.
    tellPresence(true);
    resub.hello();
    afterHello = true;
  });
  on("runners", (m) => {
    const before = get().runners;
    const runners = mergeRunners(before, m.runners, Date.now());
    // A runner that reconnected lost its routes on the server: its sessions need fresh snapshots.
    const back = reconnected(before, runners);
    resub.runners(back);
    for (const r of runners) if (r.online && (afterHello || back.includes(r.id))) refreshRunner(r.id);
    afterHello = false;
    saveKnown(runners);
    set({ runners });
    // A runner that connected (or came back) hears of this device's subscription.
    void syncPush(get().pushKey, runners.filter((r) => r.online && (back.includes(r.id) || !before.find((b) => b.id === r.id)?.online)).map((r) => r.id));
  });
  on("summary", (m) => {
    const cur = get().summaries[m.runnerId] ?? emptySummary();
    const { state, relist } = applySummary(cur, m.summary);
    set((s) => ({ summaries: { ...s.summaries, [m.runnerId]: state } }));
    if (relist) void listSummaries(m.runnerId);
    // An open session's header follows its summary (title, status).
    if (m.summary.kind !== "remove")
      for (const sum of m.summary.sessions) {
        const entry = models.get(key(m.runnerId, sum.id));
        if (entry?.model.view.window) {
          entry.model.setSummary(sum);
          publish(m.runnerId, sum.id);
        }
      }
  });
  on("event", (m) => {
    const entry = models.get(key(m.runnerId, m.sessionId));
    if (!entry) return;
    act(m.runnerId, m.sessionId, entry.model.onEvent(m.seq, m.event));
  });
  connect();
}

function act(runnerId: string, sessionId: string, v: Verdict) {
  publish(runnerId, sessionId);
  if (v === "refresh") subscriptions.refresh(runnerId, sessionId);
}

function publish(runnerId: string, sessionId: string) {
  const entry = models.get(key(runnerId, sessionId));
  if (entry) set((s) => ({ views: { ...s.views, [key(runnerId, sessionId)]: entry.model.view } }));
}

/** A runner's session list and projects, fetched again (it connected, or the list fell behind). */
export function refreshRunner(runnerId: string) {
  void listSummaries(runnerId);
  void loadProjects(runnerId);
}

async function listSummaries(runnerId: string) {
  try {
    const r = await rpc(runnerId, "listSessions", {});
    if (r.epoch === undefined || r.seq === undefined) return;
    const cur = get().summaries[runnerId] ?? emptySummary();
    const { state } = applySummary(cur, { kind: "all", epoch: r.epoch, seq: r.seq, sessions: r.sessions });
    set((s) => ({ summaries: { ...s.summaries, [runnerId]: state } }));
  } catch {
    // offline or an older runner: the next connect tries again
  }
}

export async function loadProjects(runnerId: string) {
  try {
    const { projects } = await rpc(runnerId, "listProjects", {});
    set((s) => ({ projects: { ...s.projects, [runnerId]: projects } }));
  } catch {}
}

export const modelListKey = (runnerId: string, harness: HarnessId) => `${runnerId}\u0000${harness}`;
export const viewKey = key;

/** Models, efforts and permission modes for a harness (as a session runs now, when given). */
export async function loadModels(runnerId: string, harness: HarnessId, sessionId?: string): Promise<ModelList | undefined> {
  try {
    const list = await rpc(runnerId, "listModels", { harness, sessionId });
    set((s) => ({ modelLists: { ...s.modelLists, [modelListKey(runnerId, harness)]: list } }));
    return list;
  } catch {
    return undefined;
  }
}

/** Opens a session on this page: subscribes, and keeps it current until the returned close. */
export function openView(runnerId: string, sessionId: string): () => void {
  const k = key(runnerId, sessionId);
  let entry = models.get(k);
  if (!entry) models.set(k, (entry = { model: new SessionModel(), watchers: 0 }));
  entry.watchers++;
  const mine = entry;
  const close = subscriptions.watch({
    runnerId,
    sessionId,
    onSnapshot: (snap) => {
      act(runnerId, sessionId, mine.model.onSnapshot(snap));
      void closeGap(runnerId, sessionId);
    },
    onError: (e) => {
      mine.model.onError(e);
      publish(runnerId, sessionId);
    },
  });
  return () => {
    close();
    if (--mine.watchers > 0) return;
    models.delete(k);
    set((s) => {
      const views = { ...s.views };
      delete views[k];
      return { views };
    });
  };
}

const closing = new Set<string>();

/** A reconnect's snapshot didn't reach what was loaded: pages the gap in, so the reader keeps their place. */
async function closeGap(runnerId: string, sessionId: string) {
  const k = key(runnerId, sessionId);
  const entry = models.get(k);
  if (!entry || closing.has(k)) return;
  closing.add(k);
  try {
    for (let before = entry.model.gapBefore; before; before = entry.model.gapBefore) {
      const page = await rpc(runnerId, "history", { sessionId, before, limit: GAP_PAGE }).catch(() => undefined);
      if (models.get(k) !== entry) return;
      entry.model.fillGap(before, page);
      publish(runnerId, sessionId);
    }
  } finally {
    closing.delete(k);
  }
}

const paging = new Set<string>();

/** Fetches the page before the oldest loaded message. False when there was nothing to fetch. */
export async function loadOlder(runnerId: string, sessionId: string): Promise<boolean> {
  const k = key(runnerId, sessionId);
  const entry = models.get(k);
  const w = entry?.model.view.window;
  const first = w?.messages[0];
  if (!entry || !first || !w!.hasOlder || paging.has(k)) return false;
  paging.add(k);
  try {
    const page = await rpc(runnerId, "history", { sessionId, before: first.id });
    if (models.get(k) !== entry) return false;
    entry.model.prepend(page);
    publish(runnerId, sessionId);
    return true;
  } catch {
    return false;
  } finally {
    paging.delete(k);
  }
}

/** Drops a disconnected runner from this browser's list. */
export function forgetRunner(id: string) {
  const runners = sortRunners(get().runners.filter((r) => r.id !== id || r.online));
  saveKnown(runners);
  set({ runners });
}

// Dev builds only: the store on window, for the end-to-end scripts (one instance across vite reloads).
if (import.meta.env?.DEV) (globalThis as any).__tetherStore = useStore;
