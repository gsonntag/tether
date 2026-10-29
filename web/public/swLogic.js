// The service worker's decisions, pure so they are tested without a browser (swLogic.test.ts) and
// loaded by public/sw.js with importScripts (a classic script: no module syntax here).

/** Where a notification leads: the session it is about (the page's own hash route), else Home. */
function tetherUrlFor(payload, origin) {
  if (payload && payload.runnerId && payload.sessionId) return origin + "/#/s/" + encodeURIComponent(payload.runnerId) + "/" + encodeURIComponent(payload.sessionId);
  return origin + "/#/";
}

/** The notification to show for a push payload (title, options). */
function tetherNotification(payload) {
  var p = payload || {};
  var title = p.kind === "failed" ? "Failed · " + (p.title || "Tether") : p.kind === "request" ? "Needs you · " + (p.title || "Tether") : p.title || "Tether";
  return {
    title: title,
    options: {
      body: p.body || "",
      tag: p.tag || undefined,
      renotify: p.kind === "request",
      icon: "/icon.svg",
      badge: "/icon.svg",
      timestamp: p.ts || Date.now(),
      data: { url: null, runnerId: p.runnerId, sessionId: p.sessionId, kind: p.kind },
    },
  };
}

/**
 * A window already looking at the session (visible and focused) shows it: the notification would
 * repeat what is on screen. The runner already skips devices looking at it; this covers the moment
 * between the push leaving and arriving.
 */
function tetherOnScreen(clients, url) {
  for (var i = 0; i < clients.length; i++) {
    var c = clients[i];
    if (c.focused && c.visibilityState === "visible" && c.url === url) return true;
  }
  return false;
}

/** Which open window a click goes to: one already on that session, else any Tether window. */
function tetherPickClient(clients, url) {
  for (var i = 0; i < clients.length; i++) if (clients[i].url === url) return clients[i];
  return clients[0] || null;
}

if (typeof module !== "undefined") module.exports = { tetherUrlFor, tetherNotification, tetherOnScreen, tetherPickClient };
