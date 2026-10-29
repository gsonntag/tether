// Tether server: the Foliation app's backend (relay.ts does the routing, app.ts the front door).

import { startApp } from "./app";
import { DEV, PRODUCTION_CONFIG_ERROR } from "./identity";
import { loadPushKeys } from "./push";

if (PRODUCTION_CONFIG_ERROR) {
  console.error(PRODUCTION_CONFIG_ERROR);
  process.exit(1);
}

const port = Number(process.env.PORT) || 8790;
const allowedOrigins = (process.env.TETHER_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
// Dev mode treats every browser as the owner, so it never listens beyond loopback.
const push = await loadPushKeys(process.env, DEV);
const { server } = startApp({ port, hostname: process.env.PORT && !DEV ? "0.0.0.0" : "127.0.0.1", allowedOrigins, push: push.keys });
console.log(push.note);

console.log(`Tether server on ${server.hostname}:${server.port}${DEV ? " (dev mode: no Foliation identity)" : ""}`);
