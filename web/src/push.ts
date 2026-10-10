// Web Push for this device. Each runner signs pushes with its own key, so the service worker is
// registered once per runner, each under its own scope (/push/<runnerId>/), each with its own
// subscription. Settings act on the runner currently selected.

import type { NotifyKind } from "./shared/protocol";
import { rpc, useStore } from "./store";

export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** iPhone/iPad only allow push for a web app added to the Home Screen. */
export const needsHomeScreen = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator as any).standalone;

const scope = (runnerId: string) => new URL(`/push/${encodeURIComponent(runnerId)}/`, location.origin).href;

export const pushOnHere = (runnerId: string) => localStorage.getItem(`tether.push.${runnerId}`) === "1";

async function registration(runnerId: string): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: scope(runnerId) });
  const sw = reg.installing ?? reg.waiting;
  if (sw && !reg.active)
    await new Promise<void>((res) => sw.addEventListener("statechange", () => sw.state === "activated" && res()));
  return reg;
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (b64url + "=".repeat((4 - (b64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function sameKey(sub: PushSubscription, publicKey: string) {
  const k = sub.options.applicationServerKey;
  if (!k) return false;
  const a = new Uint8Array(k);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return [br, os].filter(Boolean).join(" on ");
}

async function currentSub(runnerId: string) {
  const reg = await navigator.serviceWorker.getRegistration(scope(runnerId));
  // getRegistration falls back to the closest enclosing scope: the app worker at "/" (app-sw.js).
  if (reg?.scope !== scope(runnerId)) return null;
  return reg.pushManager.getSubscription();
}

/** What this device gets from the selected runner (undefined kinds: notifications off). */
export async function pushState(): Promise<{ kinds?: NotifyKind[]; permission: NotificationPermission }> {
  const runnerId = useStore.getState().runnerId;
  if (!runnerId || !pushSupported()) return { permission: "denied" };
  const sub = await currentSub(runnerId);
  const st = await rpc("pushStatus", { endpoint: sub?.endpoint });
  const on = !!sub && !!st.kinds && sameKey(sub, st.publicKey);
  localStorage.setItem(`tether.push.${runnerId}`, on ? "1" : "0");
  return { kinds: on ? st.kinds : undefined, permission: Notification.permission };
}

/** Turns notifications on for this device (or changes which kinds it gets). */
export async function enablePush(kinds: NotifyKind[]) {
  const runnerId = useStore.getState().runnerId;
  if (!runnerId) throw new Error("No runner is connected");
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked for this site in the browser's settings.");
  const reg = await registration(runnerId);
  const { publicKey } = await rpc("pushStatus", {});
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, publicKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const j = sub.toJSON();
  await rpc("pushSubscribe", { subscription: { endpoint: j.endpoint!, keys: j.keys as { p256dh: string; auth: string } }, kinds, label: deviceLabel() });
  localStorage.setItem(`tether.push.${runnerId}`, "1");
}

export async function disablePush() {
  const runnerId = useStore.getState().runnerId;
  if (!runnerId) return;
  const sub = await currentSub(runnerId);
  if (sub) {
    await rpc("pushUnsubscribe", { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  }
  localStorage.setItem(`tether.push.${runnerId}`, "0");
}

export async function testPush() {
  const runnerId = useStore.getState().runnerId;
  const sub = runnerId && (await currentSub(runnerId));
  if (!sub) throw new Error("Turn notifications on first.");
  await rpc("pushTest", { endpoint: sub.endpoint });
}

/**
 * Messages from the service workers: "open" (a notification was clicked and this page isn't
 * controlled by that worker, so we navigate) and "showing?" (skip the notification when you're
 * already looking at that session).
 */
export function listenForOpen() {
  if (!("serviceWorker" in navigator)) return;
  // These workers never control a page, so the browser rarely checks them for a new sw.js: ask.
  navigator.serviceWorker
    .getRegistrations()
    .then((regs) => regs.forEach((r) => new URL(r.scope).pathname.startsWith("/push/") && r.update().catch(() => {})))
    .catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "open" && typeof e.data.url === "string") location.href = e.data.url;
    if (e.data?.type === "showing?")
      e.ports[0]?.postMessage(document.visibilityState === "visible" && document.hasFocus() && useStore.getState().selected === e.data.sessionId);
  });
}
