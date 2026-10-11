// Tether service worker: shows agent notifications pushed by runners, even with no tab open.
// Registered once per runner (scope /push/<runnerId>/), because each runner signs with its own key.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

const ICONS = { question: "❓", finished: "✅", blocked: "⛔", memory: "🧠" };

/** Asks a tab whether it is showing this session (its url is the one it loaded with, not the current hash). */
function isShowing(win, sessionId) {
  return new Promise((res) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => res(false), 300);
    ch.port1.onmessage = (e) => {
      clearTimeout(timer);
      res(!!e.data);
    };
    win.postMessage({ type: "showing?", sessionId }, [ch.port2]);
  });
}

/** Where tapping it goes: the session, or for a memory conflict the Memory page scrolled to it. */
const noticeUrl = (n) =>
  n.kind === "memory"
    ? `/#/r/${encodeURIComponent(n.runnerId)}/memory${n.conflictId ? `?conflict=${encodeURIComponent(n.conflictId)}` : ""}`
    : n.sessionId
      ? `/#/r/${encodeURIComponent(n.runnerId)}/s/${encodeURIComponent(n.sessionId)}`
      : "/";

self.addEventListener("push", (e) => {
  let n;
  try {
    n = e.data.json();
  } catch {
    n = { kind: "finished", title: "Tether", body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    (async () => {
      // Skip it when you're already looking at that session.
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const visible = wins.filter((w) => w.focused && w.visibilityState === "visible");
      if (n.sessionId && (await Promise.all(visible.map((w) => isShowing(w, n.sessionId)))).some(Boolean)) return;
      await self.registration.showNotification(`${ICONS[n.kind] ?? ""} ${n.title}`.trim(), {
        body: n.body,
        tag: n.sessionId ? `${n.sessionId}:${n.kind}` : n.id,
        renotify: true,
        requireInteraction: n.kind === "question",
        data: { url: noticeUrl(n) },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url ?? "/", self.location.origin).href;
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (win) {
        await win.focus();
        return win.navigate ? win.navigate(url).catch(() => win.postMessage({ type: "open", url })) : win.postMessage({ type: "open", url });
      }
      return self.clients.openWindow(url);
    })(),
  );
});
