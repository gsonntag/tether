// Run as its own process (piGoalFilter in pi.ts): asks pi's own package manager which extensions a
// pi session in <cwd> would load, from the user's ~/.pi/agent settings, without installing
// anything or taking pi's settings lock (the settings are read here and handed over in memory).
// Project settings count as untrusted, as pi's bootstrap pass does; the caller doesn't filter a
// project that has its own pi resources.
//
//   bun piResolve.ts <pi package root> <cwd> <agent dir>
//
// Prints {"extensions": [{"path", "enabled", "source"}]}: a package's extension files carry its
// source ("npm:pi-goal-x"), built-ins are "builtin:<name>" paths.

import { readFileSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const [root, cwd, agentDir] = process.argv.slice(2);
  if (!root || !cwd || !agentDir) throw new Error("usage: piResolve.ts <pi root> <cwd> <agent dir>");
  const [{ SettingsManager }, { DefaultPackageManager }] = await Promise.all([
    import(join(root, "dist/core/settings-manager.js")) as Promise<any>,
    import(join(root, "dist/core/package-manager.js")) as Promise<any>,
  ]);
  let settings: any = {};
  try {
    settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  const settingsManager = SettingsManager.inMemory(settings, { projectTrusted: false });
  // pi's built-in extensions, by name (dist/extensions/index.js lists them; importing it would load them all).
  // Older pi has none; a file whose list can't be read stops here (the caller then filters nothing).
  let builtinExtensions: string[] = [];
  let index: string | undefined;
  try {
    index = readFileSync(join(root, "dist/extensions/index.js"), "utf8");
  } catch {}
  if (index !== undefined) {
    builtinExtensions = [...index.matchAll(/\{\s*name:\s*"([^"]+)"[^}]*builtin:\s*true/g)].map((m) => m[1]!);
    if (!builtinExtensions.length) throw new Error("couldn't read pi's built-in extensions");
  }
  const pm = new DefaultPackageManager({ cwd, agentDir, settingsManager, builtinExtensions });
  const r = await pm.resolve(async () => "skip");
  const extensions = r.extensions.map((e: any) => ({ path: e.path, enabled: !!e.enabled, source: String(e.metadata?.source ?? "") }));
  process.stdout.write(JSON.stringify({ extensions, builtins: builtinExtensions }));
}

if (import.meta.main)
  main().catch((e) => {
    process.stderr.write(String(e?.stack ?? e));
    process.exit(1);
  });
