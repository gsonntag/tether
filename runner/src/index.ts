// Tether runner: runs coding agents on this machine and serves them to the Tether app. It dials
// out to the app (TETHER_URL) with an app service token (TETHER_TOKEN).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";
import { detectHarnesses } from "./adapters/detect";
import { CONFIG_DIR, displayName, loadConfig } from "./config";
import { createRunner } from "./core/runner";
import { MODULES, startModules } from "./modules";

const config = loadConfig();
const runner = createRunner({
  url: process.env.TETHER_URL || "http://localhost:8790",
  token: process.env.TETHER_TOKEN || "dev",
  runnerId: config.runnerId,
  name: displayName(config),
  version: pkg.version,
  detectHarnesses: () => detectHarnesses(),
});

mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
const stopModules = await startModules(MODULES, (m) => {
  const dataDir = join(CONFIG_DIR, "modules", m.name);
  mkdirSync(dataDir, { recursive: true });
  return { bus: runner.bus, ops: runner.ops, dataDir, log: (line) => console.log(`[${m.name}] ${line}`) };
});

console.log(`Tether runner ${pkg.version}: ${displayName(config)} (${config.runnerId}), config in ${CONFIG_DIR}`);
console.log(`harnesses: ${(await runner.harnesses()).map((h) => `${h.id} ${h.version}`).join(", ") || "none found"}`);
runner.start();

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    stopModules();
    runner.stop();
    process.exit(0);
  });
