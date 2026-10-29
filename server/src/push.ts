// The app's VAPID key pair for Web Push (SPEC §11 P5). The server keeps it; runners send the pushes.
//
// Why runners send: they are always on, see every session, keep each device's subscription in their
// own config dir, and have the internet access a push service needs (a Foliation app has none
// unless the owner approves it). Why the server keeps the key: one key for the whole app, so a
// device subscribes once and every runner can notify it. The server hands the pair to each runner
// on connect (`welcome`) and the public key to each browser (`hello`).
//
// Production reads TETHER_VAPID_PUBLIC_KEY and TETHER_VAPID_PRIVATE_KEY (base64url, as
// `bun server/scripts/vapid-keys.ts` or web-push prints them). Without them push is off: a key made
// up at start would change with every deploy and silently break every device's subscription. Dev
// mode makes a pair per server process (browsers subscribe again when the key changes).
// TETHER_PUSH_SUBJECT sets the VAPID contact (an https URL or mailto:); runners default to their
// TETHER_URL.

import type { PushKeys } from "../../shared/protocol";

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** A fresh P-256 pair in web-push's format. */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: b64url(raw), privateKey: jwk.d! };
}

/** A pair given in env must be well formed: a 65-byte uncompressed point and a 32-byte scalar. */
export function validVapid(publicKey: string, privateKey: string): boolean {
  try {
    const pub = Buffer.from(publicKey, "base64url");
    const priv = Buffer.from(privateKey, "base64url");
    return pub.length === 65 && pub[0] === 4 && priv.length === 32;
  } catch {
    return false;
  }
}

/** The keys this server hands out, or undefined (push off), with a line to log. */
export async function loadPushKeys(env: Record<string, string | undefined>, dev: boolean): Promise<{ keys?: PushKeys; note: string }> {
  const subject = env.TETHER_PUSH_SUBJECT?.trim() || "";
  const pub = env.TETHER_VAPID_PUBLIC_KEY?.trim();
  const priv = env.TETHER_VAPID_PRIVATE_KEY?.trim();
  if (pub && priv) {
    if (!validVapid(pub, priv)) return { note: "push is off: TETHER_VAPID_PUBLIC_KEY / TETHER_VAPID_PRIVATE_KEY aren't a valid P-256 pair (base64url)" };
    return { keys: { publicKey: pub, privateKey: priv, subject }, note: "push keys from the environment" };
  }
  if (!dev) return { note: "push is off: set TETHER_VAPID_PUBLIC_KEY and TETHER_VAPID_PRIVATE_KEY (bun server/scripts/vapid-keys.ts makes a pair)" };
  return { keys: { ...(await generateVapidKeys()), subject }, note: "push keys made for this dev server" };
}
