// The page's place in the URL hash, so reload and the phone's back button work:
//   #/                                 Home (runners)
//   #/s/<runnerId>/<sessionId>          a session (both URI-encoded)

import { useSyncExternalStore } from "react";

export type Route = { page: "home" } | { page: "session"; runnerId: string; sessionId: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/");
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
  return r.page === "session" ? `#/s/${encodeURIComponent(r.runnerId)}/${encodeURIComponent(r.sessionId)}` : "#/";
}

export function navigate(r: Route) {
  const h = formatRoute(r);
  if (location.hash !== h) location.hash = h;
}

export const openSession = (runnerId: string, sessionId: string) => navigate({ page: "session", runnerId, sessionId });

const subscribe = (fn: () => void) => {
  window.addEventListener("hashchange", fn);
  return () => window.removeEventListener("hashchange", fn);
};

/** The current route; re-renders on navigation. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => location.hash);
  return parseRoute(hash);
}
