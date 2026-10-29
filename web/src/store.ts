// App state the shell renders: the link to the server, who is signed in, and the runners.

import { create } from "zustand";
import { PROTOCOL_VERSION, type User } from "../../shared/protocol";
import { connect, on, onAuth, onLinkState, type AuthState, type LinkState } from "./connection";
import { loadKnown, mergeRunners, saveKnown, sortRunners, type KnownRunner } from "./runners";

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
  on("hello", (m) => set({ user: m.user, stale: m.protocol !== PROTOCOL_VERSION }));
  on("runners", (m) => {
    const runners = mergeRunners(useStore.getState().runners, m.runners, Date.now());
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
