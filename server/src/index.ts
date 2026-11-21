// Tether server: the Foliation app's backend (relay.ts does the routing, app.ts the front door).

import { startApp } from "./app";
import { readBuildInfo } from "./build";
import { DEV, PRODUCTION_CONFIG_ERROR } from "./identity";
import { loadPushKeys } from "./push";
import { parseRunnerOwners, type RunnerOwners } from "./tenancy";
import { join } from "node:path";

if (PRODUCTION_CONFIG_ERROR) {
  console.error(PRODUCTION_CONFIG_ERROR);
  process.exit(1);
}

let owners: RunnerOwners | null;
try {
  owners = parseRunnerOwners(process.env.TETHER_RUNNER_OWNERS);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
if (owners) console.log(`Several tenants: ${owners.size} runner token(s) in TETHER_RUNNER_OWNERS; each person sees only their own runners.`);

const port = Number(process.env.PORT) || 8790;
const allowedOrigins = (process.env.TETHER_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
// Dev mode treats every browser as the owner, so it never listens beyond loopback.
const push = await loadPushKeys(process.env, DEV);
const build = await readBuildInfo(join(import.meta.dir, ".."));
const { server } = startApp({ port, hostname: process.env.PORT && !DEV ? "0.0.0.0" : "127.0.0.1", allowedOrigins, push: push.keys, owners, build });
if (build) console.log(`Tether server build ${build.commit} (${build.date}${build.dirty ? ", local changes" : ""})`);
console.log(push.note);

console.log(`Tether server on ${server.hostname}:${server.port}${DEV ? " (dev mode: no Foliation identity)" : ""}`);
