// Tether app service worker (scope "/"): shows an offline screen instead of the browser's error page.
//
// It only handles page navigations, and always goes to the network first: the HTML and the app's
// assets are never cached, so a deploy shows up on the next load as before. Only offline.html is
// cached, in a versioned cache. /api is never touched.
//
// Push notifications are a separate worker (sw.js, one per runner under /push/<runnerId>/); the two
// scopes don't overlap, so neither affects the other.

const VERSION = "v1";
const CACHE = `tether-offline-${VERSION}`;
const OFFLINE = "/offline.html";

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.add(new Request(OFFLINE, { cache: "reload" }));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith("tether-offline-") && k !== CACHE) await caches.delete(k);
      // Lets the browser start the page request while this worker boots.
      await self.registration.navigationPreload?.enable().catch(() => {});
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.mode !== "navigate" || req.method !== "GET") return;
  if (new URL(req.url).pathname.startsWith("/api/")) return;
  e.respondWith(
    (async () => {
      try {
        return (await e.preloadResponse) ?? (await fetch(req));
      } catch {
        return (await caches.match(OFFLINE, { cacheName: CACHE })) ?? Response.error();
      }
    })(),
  );
});
