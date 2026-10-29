// Tether runner: runs coding agents on this machine and serves them to the Tether app. It dials
// out to the app (TETHER_URL) with an app service token (TETHER_TOKEN).

import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type HarnessInfo, type RunnerInfo } from "../../shared/protocol";
import pkg from "../package.json";
import { detectHarnesses } from "./adapters/detect";
import { CONFIG_DIR, loadConfig } from "./config";
import { EventBus } from "./core/bus";
import { Connection } from "./core/connection";
import type { CoreEvents } from "./core/events";
import { OpRegistry } from "./core/ops";
import { MODULES, startModules } from "./modules";

const URL_BASE = process.env.TETHER_URL || "http://localhost:8790";
const TOKEN = process.env.TETHER_TOKEN || "dev";

const config = loadConfig();
const bus = new EventBus<CoreEvents>();
const ops = new OpRegistry();

ops.register("ping", () => ({ runnerId: config.runnerId, at: Date.now() }));

// Harnesses installed (or removed) while the runner runs count from the next check.
let harnesses: Promise<HarnessInfo[]> = detectHarnesses();
const helloInfo = async (): Promise<Omit<RunnerInfo, "connectedAt">> => ({
  id: config.runnerId,
  hostname: hostname(),
  version: pkg.version,
  protocol: PROTOCOL_VERSION,
  harnesses: await harnesses,
});
setInterval(async () => {
  const before = JSON.stringify(await harnesses);
  harnesses = detectHarnesses();
  // A repeated hello on the same connection just updates what the browsers see.
  if (JSON.stringify(await harnesses) !== before) conn.send({ t: "hello", runner: await helloInfo() });
}, 5 * 60_000).unref();

const conn = new Connection({
  url: URL_BASE,
  token: TOKEN,
  hello: helloInfo,
  onRpc: (op, args) => ops.handle(op, args),
  onDetach: () => {}, // terminals arrive in P3
});

mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
const stopModules = await startModules(MODULES, (m) => {
  const dataDir = join(CONFIG_DIR, "modules", m.name);
  mkdirSync(dataDir, { recursive: true });
  return { bus, ops, dataDir, log: (line) => console.log(`[${m.name}] ${line}`) };
});

console.log(`Tether runner ${pkg.version}: ${config.runnerId}, config in ${CONFIG_DIR}`);
console.log(`harnesses: ${(await harnesses).map((h) => `${h.id} ${h.version}`).join(", ") || "none found"}`);
conn.start();

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    stopModules();
    conn.stop();
    process.exit(0);
  });
