// Presence: what this device is looking at, told to the server (protocol.ts `presence`). A session
// counts while its page is visible; a hidden tab, a locked phone or Home looks at nothing. Runners
// use it to mark a session read and to skip notifying this device about it. The server forgets it
// with the socket, so it is said again on every connect. A phone whose terminal panel covers the
// session doesn't count: it can't see the requests dock, so notifications still reach it.

import { sendFrame } from "./connection";
import { deviceId } from "./device";
import { linkCache } from "./linkCache";
import { parseRoute, presenceFor } from "./route";

const homePage = (hash: string) => parseRoute(hash).page === "home";

let last = "";
let covered = false;
/** the Home agent's chat while Home shows it: Home looks at it */
let homeChat: { runnerId: string; sessionId: string } | undefined;

export function setHomeChat(chat: { runnerId: string; sessionId: string } | undefined) {
  homeChat = chat;
  tellPresence();
}

/** The terminal panel covers the session on this device (a phone), or no longer does. */
export function setSessionCovered(on: boolean) {
  if (on === covered) return;
  covered = on;
  tellPresence();
}

/** Says what this device looks at now (only when it changed, unless `force`). */
export function tellPresence(force = false) {
  const visible = document.visibilityState === "visible";
  let p = presenceFor(location.hash, visible && !covered);
  if (!p.sessionId && visible && homeChat && homePage(location.hash)) p = homeChat;
  const key = JSON.stringify(p);
  if (!force && key === last) return;
  if (sendFrame({ t: "presence", deviceId: deviceId(), ...p })) last = key;
}

export function startPresence() {
  window.addEventListener("hashchange", () => tellPresence());
  // A short link's session became known: the page now shows it.
  linkCache.subscribe(() => tellPresence());
  document.addEventListener("visibilitychange", () => tellPresence());
  window.addEventListener("pagehide", () => tellPresence());
}
