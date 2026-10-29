// This device's own random id, kept in the browser: runners use it to skip notifying a device about
// the session it is looking at (presence), and to keep one push subscription per device.

const KEY = "tether.deviceId";
let id: string | undefined;

export function deviceId(): string {
  if (id) return id;
  try {
    id = localStorage.getItem(KEY) ?? undefined;
  } catch {}
  if (!id) {
    id = crypto.randomUUID();
    try {
      localStorage.setItem(KEY, id);
    } catch {}
  }
  return id;
}

/** "Chrome on Android": a label for this device's subscription. */
export function deviceLabel(ua = navigator.userAgent): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}
