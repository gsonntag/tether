// The page's place in the URL hash, so reload and the phone's back button work:
//   #/                                 Home (runners)
//   #/s/<runnerId>/<sessionId>          a session (both URI-encoded)
//   #/settings/credentials, #/settings/azure, #/settings/texting, #/settings/notifications, #/settings/agents   Settings' subpages

import { useSyncExternalStore } from "react";

export type Route = { page: "home" } | { page: "credentials" } | { page: "azure" } | { page: "texting" } | { page: "notifications" } | { page: "agents" } | { page: "session"; runnerId: string; sessionId: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/");
  if (parts[0] === "settings" && parts[1] === "azure") return { page: "azure" };
  if (parts[0] === "settings" && parts[1] === "texting") return { page: "texting" };
  if (parts[0] === "settings" && parts[1] === "notifications") return { page: "notifications" };
  if (parts[0] === "settings" && parts[1] === "agents") return { page: "agents" };
  if (parts[0] === "credentials" || parts[0] === "settings") return { page: "credentials" };
  if (parts[0] === "s" && parts[1] && parts[2]) {
    try {
      return { page: "session", runnerId: decodeURIComponent(parts[1]), sessionId: decodeURIComponent(parts.slice(2).join("/")) };
    } catch {
      return { page: "home" };
    }
  }
  return { page: "home" };
}

/** What a device looks at (presence.ts): a session while the page is visible, else nothing. */
export function presenceFor(hash: string, visible: boolean): { runnerId?: string; sessionId?: string } {
  const r = parseRoute(hash);
  return visible && r.page === "session" ? { runnerId: r.runnerId, sessionId: r.sessionId } : {};
}

export function formatRoute(r: Route): string {
  return r.page === "session" ? `#/s/${encodeURIComponent(r.runnerId)}/${encodeURIComponent(r.sessionId)}` : r.page === "credentials" ? "#/settings/credentials" : r.page === "azure" ? "#/settings/azure" : r.page === "texting" ? "#/settings/texting" : r.page === "notifications" ? "#/settings/notifications" : r.page === "agents" ? "#/settings/agents" : "#/";
}

export function navigate(r: Route) {
  const h = formatRoute(r);
  if (location.hash !== h) location.hash = h;
}

export const openSession = (runnerId: string, sessionId: string) => navigate({ page: "session", runnerId, sessionId });

/** The same, in place of the page in the history: Back doesn't land on a session that only moves on. */
export const replaceSession = (runnerId: string, sessionId: string) => location.replace(formatRoute({ page: "session", runnerId, sessionId }));

const subscribe = (fn: () => void) => {
  window.addEventListener("hashchange", fn);
  return () => window.removeEventListener("hashchange", fn);
};

/** The current route; re-renders on navigation. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => location.hash);
  return parseRoute(hash);
}
