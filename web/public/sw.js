// Tether's service worker: shows Web Push notifications (SPEC §11 P5) and opens the session a
// notification is about. The decisions are in /swLogic.js (tested in web/src/swLogic.test.ts).
/* eslint-disable no-restricted-globals */
importScripts("/swLogic.js");

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Tether", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    (async () => {
      const url = tetherUrlFor(payload, self.location.origin);
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Browsers require every push to show something unless a window of ours is focused.
      if (payload.kind !== "test" && tetherOnScreen(windows, url)) return;
      const n = tetherNotification(payload);
      n.options.data.url = url;
      await self.registration.showNotification(n.title, n.options);
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.location.origin + "/#/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const c = tetherPickClient(windows, url);
      if (c) {
        // The page moves itself (navigate() on a hash change can reload it on some browsers).
        c.postMessage({ t: "open", url });
        try {
          await c.focus();
        } catch {}
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
