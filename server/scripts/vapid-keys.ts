// Prints a fresh VAPID key pair for the app's env (server/src/push.ts):
//   bun server/scripts/vapid-keys.ts
import { generateVapidKeys } from "../src/push";

const k = await generateVapidKeys();
console.log(`TETHER_VAPID_PUBLIC_KEY=${k.publicKey}`);
console.log(`TETHER_VAPID_PRIVATE_KEY=${k.privateKey}`);
