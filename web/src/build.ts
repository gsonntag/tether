// Whether this page runs the newest web build. The protocol version only changes with the wire
// format, so a page opened before a deploy that changed just the UI kept the old one and never said
// so (a Home agent settings chip that "isn't there"). Each build writes its id to build.json
// (vite.config.ts); another id there marks the page stale, which shows "Tether was updated" with
// Reload. Checked on every (re)connect and when the page comes back into view, at most once a minute.

declare const __TETHER_BUILD__: string;

/** this page's build; "dev" under vite's dev server (and in tests): never stale */
const BUILD = typeof __TETHER_BUILD__ === "string" ? __TETHER_BUILD__ : "dev";
const EVERY_MS = 60_000;
let last = -Infinity;

/** Asks for the deployed build's id; calls `stale` if it isn't this page's. Silent on any failure. */
export async function checkBuild(stale: () => void, now = Date.now(), load: () => Promise<unknown> = fetchBuild, mine = BUILD): Promise<void> {
  if (mine === "dev" || now - last < EVERY_MS) return;
  last = now;
  try {
    const v = (await load()) as { build?: unknown } | undefined;
    if (typeof v?.build === "string" && v.build && v.build !== mine) stale();
  } catch {}
}

async function fetchBuild(): Promise<unknown> {
  const r = await fetch(`/build.json?t=${Date.now()}`, { cache: "no-store" });
  return r.ok ? r.json() : undefined;
}
