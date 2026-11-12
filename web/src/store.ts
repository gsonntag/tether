// App state the shell renders: the link to the server, who is signed in, the runners, their
// session lists and projects, and the sessions this page has open.

import { create } from "zustand";
import { mergeHomeChat } from "./homeTabs";
import { checkBuild } from "./build";
import { PROTOCOL_VERSION, type HomeChatUpdate, type User } from "../../shared/protocol";
import { applySummary, emptySummary, type SummaryState } from "../../shared/summary";
import type { HarnessId, ModelList, ProjectInfo } from "../../shared/transcript";
import { connect, on, onAuth, onLinkState, rpc, type AuthState, type LinkState } from "./connection";
import { linkCache } from "./linkCache";
import { startPresence, tellPresence } from "./presence";
import { openSession, parseRoute, shortenHash, startShortUrls } from "./route";
import { registerWorker, syncPush } from "./push";
import { loadKnown, mergeRunners, reconnected, saveKnown, sortRunners, type KnownRunner } from "./runners";
import { setHomeFolders, type Watching } from "./sessionList";
import { SessionModel, type SessionView, type Verdict } from "./sessionModel";
import { resubscriber, Subscriptions } from "./subscriptions";
import { pendingSender, reconcile, type PendingSend } from "./pendingSends";

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
  /** messages sent from this page whose own message hasn't come yet (pendingSends.ts), by runner and session */
  pending: Record<string, PendingSend[]>;
  /** the new-session dialog */
  newSessionOpen: boolean;
  /** the sidebar shows only this folder's sessions */
  projectFilter?: string;
  /** the app's VAPID public key (hello); absent: the server has no push keys */
  pushKey?: string;
  /** the last archive change made here: the sidebar patches its listSessions copies with it */
  archiveEdit?: { runnerId: string; sessionId: string; archived: boolean };
  /** each runner's Home agent tabs and current chat (none: the next message starts one), newest `rev` wins */
  homeChats: Record<string, HomeChatUpdate>;
  /** each runner's "Watch all sessions" and the sessions its Home agent follows (homeAgentWatch) */
  homeWatch: Record<string, Watching>;
}

const known = loadKnown();
setHomeFolders(known);

export const useStore = create<State>(() => ({
  link: "connecting",
  everOpen: false,
  auth: "ok",
  stale: false,
  runners: known,
  sidebarOpen: false,
  summaries: {},
  projects: {},
  modelLists: {},
  views: {},
  pending: {},
  newSessionOpen: false,
  homeChats: {},
  homeWatch: {},
}));

const set = useStore.setState;
const get = useStore.getState;

export function start() {
  const markStale = () => set({ stale: true });
  onLinkState((link) => {
    set((s) => ({ link, everOpen: s.everOpen || link === "open" }));
    if (link === "open") void checkBuild(markStale);
  });
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void checkBuild(markStale));
  onAuth((auth) => set({ auth }));
  const resub = resubscriber(subscriptions);
  /** the next runners frame follows our own (re)connect: every runner's lists may be stale */
  let afterHello = false;
  startPresence();
  // The bar shows a session by its short link: codes come from its runner.
  linkCache.setAsk((runnerId, sessionId) => rpc(runnerId, "linkFor", { sessionId }, 8_000).then((r) => r?.code ?? null));
  startShortUrls();
  // A notification clicked while a Tether window is open: that window opens the session (by its short link, when known).
  registerWorker((url) => {
    const at = url.indexOf("#");
    if (at < 0) return;
    const r = parseRoute(url.slice(at));
    if (r.page === "session") openSession(r.runnerId, r.sessionId);
    else location.hash = url.slice(at);
  });
  on("hello", (m) => {
    set((s) => ({ user: m.user, stale: s.stale || m.protocol !== PROTOCOL_VERSION, pushKey: m.push?.publicKey }));
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
    setHomeFolders(runners);
    set({ runners });
    // A runner that came online may give the open session its short link now.
    if (runners.some((r) => r.online && !before.find((b) => b.id === r.id)?.online)) {
      linkCache.retrySoon();
      shortenHash();
    }
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
  // Another device started a Home chat or cleared it (/new): this one's Home follows.
  on("homeChat", ({ runnerId, sessionId, chats, labels, rev }) => {
    noteHomeChat(runnerId, { sessionId, rev, ...(chats ? { chats } : {}), ...(labels ? { labels } : {}) });
    // A server from before tabs passes no list on: the runner is asked for it.
    if (!chats)
      void rpc(runnerId, "homeAgent", {})
        .then((r) => noteHomeChat(runnerId, { sessionId: r.sessionId, rev: r.rev ?? 0, ...(r.chats ? { chats: r.chats } : {}), ...(r.labels ? { labels: r.labels } : {}) }))
        .catch(() => {});
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
  settlePending(key(runnerId, sessionId));
}

/** Drops the pending copies whose own message has come. */
function settlePending(k: string) {
  const list = get().pending[k];
  const view = get().views[k];
  if (!list?.length || !view?.window) return;
  const next = reconcile(list, view.window.messages, view.state?.queue);
  if (next !== list) setPending(k, () => next);
}

function setPending(k: string, f: (list: PendingSend[]) => PendingSend[]) {
  set((s) => {
    const next = f(s.pending[k] ?? []);
    const pending = { ...s.pending };
    if (next.length) pending[k] = next;
    else delete pending[k];
    return { pending };
  });
}

/**
 * Sends a message optimistically: it shows in the chat at once as a pending copy, and the runner's
 * message for it (tagged with the copy's clientId) replaces it. A failure leaves the copy marked
 * failed, with Retry (retrySend) and Edit (dropPending, then the text back in the box).
 */
export const sendPending = pendingSender({
  list: (k) => get().pending[k],
  update: setPending,
  newest: (k) => get().views[k]?.window?.messages.at(-1)?.id,
  settle: settlePending,
  send: (runnerId, args) => rpc(runnerId, "send", args),
  failed: failedSend,
  key,
});

/** Sends a failed copy again, in its place. */
export function retrySend(runnerId: string, sessionId: string, clientId: string, send = sendPending) {
  const p = get().pending[key(runnerId, sessionId)]?.find((x) => x.clientId === clientId);
  if (p) send(runnerId, sessionId, p.text, p.attachments, { stop: p.stop, clientId });
}

/** Takes a pending copy out of the chat (Edit: its text goes back in the box). */
export function dropPending(runnerId: string, sessionId: string, clientId: string) {
  setPending(key(runnerId, sessionId), (l) => l.filter((p) => p.clientId !== clientId));
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

/** A send (or an archive) that failed: shown in the chat of the session it was for, if that's still open. */
export function failedSend(runnerId: string, sessionId: string, text: string) {
  models.get(key(runnerId, sessionId))?.model.addNotice(text);
  publish(runnerId, sessionId);
}

/** Archives or unarchives a session (SPEC §10); throws the runner's error. */
export async function setArchived(runnerId: string, sessionId: string, archived: boolean) {
  await rpc(runnerId, "setSessionArchived", { sessionId, archived });
  set({ archiveEdit: { runnerId, sessionId, archived } });
}

/** A runner's Home agent tabs and current chat, from an rpc's answer or a broadcast: only a newer one replaces what's here. */
export function noteHomeChat(runnerId: string, u: HomeChatUpdate) {
  const next = mergeHomeChat(get().homeChats[runnerId], u);
  if (next) set((s) => ({ homeChats: { ...s.homeChats, [runnerId]: next } }));
}


/** What a runner's Home agent watches (a homeAgentWatch answer). */
export function noteHomeWatch(runnerId: string, w: Watching) {
  set((s) => ({ homeWatch: { ...s.homeWatch, [runnerId]: { watchAll: w.watchAll, ...(w.following ? { following: w.following } : {}) } } }));
}

/** Drops a disconnected runner from this browser's list. */
export function forgetRunner(id: string) {
  const runners = sortRunners(get().runners.filter((r) => r.id !== id || r.online));
  saveKnown(runners);
  set({ runners });
}

// Dev builds only: the store on window, for the end-to-end scripts (one instance across vite reloads).
if (import.meta.env?.DEV) (globalThis as any).__tetherStore = useStore;
