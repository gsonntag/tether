// Notifications on this device (SPEC §11 P5): the service worker, the browser's push subscription,
// and telling every runner about it. One subscription per device, made with the app's VAPID key
// (the server's hello carries it); every runner gets it (pushSubscribe), including runners that
// connect later. A key that changed (a dev server restart) means subscribing again.

import { rpc } from "./connection";
import { deviceId, deviceLabel } from "./device";

export type PushState = "unsupported" | "nokey" | "denied" | "off" | "on";

const KEY = "tether.push";

export const pushSupported = () => typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof window !== "undefined" && "PushManager" in window && "Notification" in window;

/** base64url -> bytes (applicationServerKey). */
export function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64url.length % 4)) % 4);
  const s = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => !!a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i]);

let registration: Promise<ServiceWorkerRegistration | undefined> | undefined;

/** Registers the service worker (once); clicks on notifications reach the page through it. */
export function registerWorker(onOpen: (url: string) => void) {
  if (!pushSupported()) return;
  registration ??= navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.t === "open" && typeof e.data.url === "string") onOpen(e.data.url);
  });
}

const wanted = () => {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
};
const want = (on: boolean) => {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {}
};

async function current(): Promise<PushSubscription | null> {
  const reg = await registration;
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** What the switch shows. */
export async function pushState(publicKey: string | undefined): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (!publicKey) return "nokey";
  if (Notification.permission === "denied") return "denied";
  return wanted() && (await current()) ? "on" : "off";
}

/** Tells these runners about this device's subscription (harmless when they have it). */
async function tell(sub: PushSubscription, runnerIds: string[]) {
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await Promise.all(runnerIds.map((id) => rpc(id, "pushSubscribe", { deviceId: deviceId(), subscription: { endpoint: json.endpoint, keys: json.keys }, label: deviceLabel() }).catch(() => {})));
}

/** Turns notifications on (from a click: the permission prompt needs one). */
export async function enablePush(publicKey: string, runnerIds: string[]): Promise<PushState> {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "denied" : "off";
  const reg = await registration;
  if (!reg) throw new Error("The service worker didn't start.");
  await navigator.serviceWorker.ready;
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  want(true);
  await tell(sub, runnerIds);
  return "on";
}

export async function disablePush(runnerIds: string[]): Promise<PushState> {
  want(false);
  const sub = await current();
  if (sub) {
    await Promise.all(runnerIds.map((id) => rpc(id, "pushUnsubscribe", { endpoint: sub.endpoint }).catch(() => {})));
    await sub.unsubscribe().catch(() => {});
  }
  return "off";
}

/**
 * Keeps a device that turned notifications on subscribed: every connected runner hears of it, and a
 * changed key means subscribing again.
 */
export async function syncPush(publicKey: string | undefined, runnerIds: string[]) {
  if (!pushSupported() || !publicKey || !wanted() || Notification.permission !== "granted" || !runnerIds.length) return;
  const reg = await registration;
  if (!reg) return;
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  try {
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch {
    return;
  }
  await tell(sub, runnerIds);
}

/** A test notification to this device from one runner. */
export async function testPush(runnerId: string) {
  const sub = await current();
  if (!sub) throw new Error("Notifications are off on this device.");
  await rpc(runnerId, "pushTest", { endpoint: sub.endpoint });
}
