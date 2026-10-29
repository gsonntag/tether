// App state the shell renders: the link to the server, who is signed in, and the runners.

import { create } from "zustand";
import { PROTOCOL_VERSION, type User } from "../../shared/protocol";
import { connect, on, onAuth, onLinkState, rpc, type AuthState, type LinkState } from "./connection";
import { loadKnown, mergeRunners, reconnected, saveKnown, sortRunners, type KnownRunner } from "./runners";
import { Subscriptions } from "./subscriptions";

/** The sessions this page has open (P1 opens them); kept subscribed across every reconnect. */
export const subscriptions = new Subscriptions(
  (runnerId, sessionId) => rpc(runnerId, "subscribe", { sessionId }),
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
}

export const useStore = create<State>(() => ({
  link: "connecting",
  everOpen: false,
  auth: "ok",
  stale: false,
  runners: loadKnown(),
  sidebarOpen: false,
}));

const set = useStore.setState;

export function start() {
  onLinkState((link) => set((s) => ({ link, everOpen: s.everOpen || link === "open" })));
  onAuth((auth) => set({ auth }));
  // hello comes once per (re)opened link, and the server dropped every subscription with the
  // old socket: subscribe again to everything. The runners message that follows hello may name
  // runners as reconnected too; resubscribing twice is harmless.
  on("hello", (m) => {
    set({ user: m.user, stale: m.protocol !== PROTOCOL_VERSION });
    subscriptions.resubscribe();
  });
  on("runners", (m) => {
    const before = useStore.getState().runners;
    const runners = mergeRunners(before, m.runners, Date.now());
    // A runner that reconnected lost its routes on the server: its sessions need fresh snapshots.
    const fresh = reconnected(before, runners);
    if (fresh.length) subscriptions.resubscribe(fresh);
    saveKnown(runners);
    set({ runners });
  });
  connect();
}

/** Drops a disconnected runner from this browser's list. */
export function forgetRunner(id: string) {
  const runners = sortRunners(useStore.getState().runners.filter((r) => r.id !== id || r.online));
  saveKnown(runners);
  set({ runners });
}
