// Tether app service worker (scope "/"): shows an offline screen instead of the browser's error page.
//
// It only handles page navigations, and always goes to the network first: the HTML and the app's
// assets are never cached, so a deploy shows up on the next load as before. Any answer from the
// network, including Foliation's sign-in redirect, goes to the page untouched; offline.html stands
// in only when the request fails outright. Only offline.html is cached, in a versioned cache.
//
// Push notifications are a separate worker (sw.js, one per runner under /push/<runnerId>/); the
// narrower scopes win for their own URLs, so neither affects the other.
//
// Changing offline.html: bump VERSION, so installed copies fetch the new one.
// Kill switch: replace this file's body with
//   self.addEventListener("install", () => self.skipWaiting());
//   self.addEventListener("activate", (e) => e.waitUntil(self.registration.unregister()));
// (deleting the file doesn't unregister it: a failed update keeps the old worker), and stop
// registering it in main.tsx.

const VERSION = "v1";
const CACHE = `tether-offline-${VERSION}`;
const OFFLINE = "/offline.html";

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      // Signed out, the edge answers with a redirect to its sign-in page: never cache that as the
      // offline page (installing fails instead, and the next load tries again).
      const res = await fetch(OFFLINE, { cache: "reload", redirect: "manual" });
      if (!res.ok || res.redirected) throw new Error(`offline page: ${res.status}`);
      await (await caches.open(CACHE)).put(OFFLINE, res);
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
  // With navigation preload on, the browser has already sent this request: answer with that one
  // (as is, no offline page) rather than letting it go out a second time.
  if (new URL(req.url).pathname.startsWith("/api/")) return e.respondWith((async () => (await e.preloadResponse) ?? fetch(req))());
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
