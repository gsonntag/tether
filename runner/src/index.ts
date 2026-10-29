// Tether runner: runs coding agents on this machine and serves them to the Tether app. It dials
// out to the app (TETHER_URL) with an app service token (TETHER_TOKEN).

import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";
import { claudeAdapter } from "./adapters/claude";
import { codexAdapter } from "./adapters/codex";
import { detectHarnesses } from "./adapters/detect";
import { CONFIG_DIR, displayName, loadConfig } from "./config";
import { createRunner } from "./core/runner";
import { MODULES, startModules } from "./modules";

// No silent defaults outside dev: a runner that quietly dialled localhost with token "dev" would
// look healthy while serving nobody.
const DEV = process.env.TETHER_DEV === "1";
const url = process.env.TETHER_URL || (DEV ? "http://localhost:8790" : "");
const token = process.env.TETHER_TOKEN || (DEV ? "dev" : "");
if (!url || !token) {
  console.error(`Set ${[!url && "TETHER_URL", !token && "TETHER_TOKEN"].filter(Boolean).join(" and ")} (the app's URL and a runner service token), or TETHER_DEV=1 for a local dev server.`);
  process.exit(1);
}

const config = loadConfig();
const runner = createRunner({
  url,
  token,
  runnerId: config.runnerId,
  name: displayName(config),
  version: pkg.version,
  detectHarnesses: () => detectHarnesses(),
  adapters: [claudeAdapter, codexAdapter],
  noticesFile: join(CONFIG_DIR, "notices.json"),
  attachmentsDir: join(CONFIG_DIR, "attachments"),
  // Hooks of TUIs in terminal mode report here (terminal/hooks.ts); the path outlives restarts.
  terminal: { hookSocket: join(CONFIG_DIR, "hooks.sock") },
});

mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
// Private: it holds runner.json and the terminal hooks' socket.
chmodSync(CONFIG_DIR, 0o700);
const stopModules = await startModules(MODULES, (m) => {
  const dataDir = join(CONFIG_DIR, "modules", m.name);
  mkdirSync(dataDir, { recursive: true });
  return { bus: runner.bus, ops: runner.ops, dataDir, log: (line) => console.log(`[${m.name}] ${line}`), runnerId: config.runnerId, appUrl: url, ...runner.look };
});

console.log(`Tether runner ${pkg.version}: ${displayName(config)} (${config.runnerId}), config in ${CONFIG_DIR}`);
console.log(`harnesses: ${(await runner.harnesses()).map((h) => `${h.id} ${h.version}`).join(", ") || "none found"}`);
await runner.start();

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, async () => {
    if (stopping) process.exit(1); // a second Ctrl-C doesn't wait
    stopping = true;
    console.log(`stopping (${sig})`);
    stopModules();
    // Live sessions' harnesses are closed so they flush; a hung one doesn't hold the exit up.
    await Promise.race([runner.stop(), Bun.sleep(5000)]);
    process.exit(0);
  });
