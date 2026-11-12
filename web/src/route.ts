// The page's place in the URL hash, so reload and the phone's back button work:
//   #/                                 Home (runners)
//   #/l/<code>                          a session, by its short link (runner modules/links): what the bar shows
//   #/s/<runnerId>/<sessionId>          a session (both URI-encoded): old links, and until the session's code is known; then replaced by its #/l/…
//   #/settings/credentials, #/settings/azure, #/settings/texting, #/settings/notifications, #/settings/agents, #/settings/updates   Settings' subpages

import { useSyncExternalStore } from "react";
import { linkCache, type LinkCache } from "./linkCache";

export type Route = { page: "home" } | { page: "credentials" } | { page: "azure" } | { page: "texting" } | { page: "notifications" } | { page: "agents" } | { page: "updates" } | { page: "session"; runnerId: string; sessionId: string; code?: string } | { page: "link"; code: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/");
  if (parts[0] === "settings" && parts[1] === "azure") return { page: "azure" };
  if (parts[0] === "settings" && parts[1] === "texting") return { page: "texting" };
  if (parts[0] === "settings" && parts[1] === "notifications") return { page: "notifications" };
  if (parts[0] === "settings" && parts[1] === "agents") return { page: "agents" };
  if (parts[0] === "settings" && parts[1] === "updates") return { page: "updates" };
  if (parts[0] === "credentials" || parts[0] === "settings") return { page: "credentials" };
  // Any code: one that can't be a code shows "doesn't exist" (ShortLink.tsx), not Home.
  if (parts[0] === "l" && parts[1]) return { page: "link", code: parts.slice(1).join("/").replace(/\/+$/, "") };
  if (parts[0] === "s" && parts[1] && parts[2]) {
    try {
      return { page: "session", runnerId: decodeURIComponent(parts[1]), sessionId: decodeURIComponent(parts.slice(2).join("/")) };
    } catch {
      return { page: "home" };
    }
  }
  return { page: "home" };
}

/** The route, with a short link this browser knows (linkCache.ts) as its session. */
export function resolveRoute(r: Route, cache: Pick<LinkCache, "session"> = linkCache): Route {
  if (r.page !== "link") return r;
  const s = cache.session(r.code);
  return s ? { page: "session", ...s, code: r.code } : r;
}

/** What a device looks at (presence.ts): a session while the page is visible, else nothing. */
export function presenceFor(hash: string, visible: boolean, cache: Pick<LinkCache, "session"> = linkCache): { runnerId?: string; sessionId?: string } {
  const r = resolveRoute(parseRoute(hash), cache);
  return visible && r.page === "session" ? { runnerId: r.runnerId, sessionId: r.sessionId } : {};
}

export function formatRoute(r: Route): string {
  if (r.page === "link" || (r.page === "session" && r.code)) return `#/l/${r.code}`;
  return r.page === "session" ? `#/s/${encodeURIComponent(r.runnerId)}/${encodeURIComponent(r.sessionId)}` : r.page === "credentials" ? "#/settings/credentials" : r.page === "azure" ? "#/settings/azure" : r.page === "texting" ? "#/settings/texting" : r.page === "notifications" ? "#/settings/notifications" : r.page === "agents" ? "#/settings/agents" : r.page === "updates" ? "#/settings/updates" : "#/";
}

export function navigate(r: Route) {
  const h = formatRoute(r);
  if (location.hash !== h) location.hash = h;
}

/** A session's place: its short link when its code is known, else the long form (shortenHash replaces it once the code comes). */
export function sessionRoute(runnerId: string, sessionId: string, cache: Pick<LinkCache, "code"> = linkCache): Route {
  const code = cache.code(runnerId, sessionId);
  return { page: "session", runnerId, sessionId, ...(code ? { code } : {}) };
}

export const openSession = (runnerId: string, sessionId: string) => {
  navigate(sessionRoute(runnerId, sessionId));
};

/** The same, in place of the page in the history: Back doesn't land on a session that only moves on. */
export const replaceSession = (runnerId: string, sessionId: string) => {
  location.replace(formatRoute(sessionRoute(runnerId, sessionId)));
};

/** The hash the bar should show for `hash`: a session's short link once its code is known (`want`: asks for one when it isn't). */
export function shortHash(hash: string, cache: Pick<LinkCache, "code" | "session" | "want"> = linkCache): string | undefined {
  const r = resolveRoute(parseRoute(hash), cache);
  if (r.page !== "session") return undefined;
  cache.want(r.runnerId, r.sessionId);
  const code = cache.code(r.runnerId, r.sessionId);
  return code && hash !== `#/l/${code}` && parseRoute(hash).page === "session" ? `#/l/${code}` : undefined;
}

/** A session shown by its long #/s/… becomes its #/l/<code> in place (same entry in the history), once the code is known. */
export function shortenHash() {
  const h = shortHash(location.hash);
  if (h) location.replace(h);
}

/** Keeps the bar short: on navigation, and when a code arrives (store.ts start()). */
export function startShortUrls() {
  window.addEventListener("hashchange", shortenHash);
  linkCache.subscribe(shortenHash);
  shortenHash();
}

const subscribe = (fn: () => void) => {
  window.addEventListener("hashchange", fn);
  const off = linkCache.subscribe(fn);
  return () => {
    window.removeEventListener("hashchange", fn);
    off();
  };
};

/** The current route (a known short link as its session); re-renders on navigation, and when a short link's session becomes known. */
export function useRoute(): Route {
  const snap = useSyncExternalStore(subscribe, () => `${linkCache.version}\u0000${location.hash}`);
  return resolveRoute(parseRoute(snap.slice(snap.indexOf("\u0000") + 1)));
}
