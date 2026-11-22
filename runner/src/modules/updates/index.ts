// Harness updates (Settings → Updates): the harnessVersions and harnessUpdate ops over check.ts,
// and "Update all harnesses when all agents idle" (auto.ts, the harnessAutoUpdate op).

import { join } from "node:path";
import type { Module } from "..";
import { AutoUpdater } from "./auto";
import { FileCompatStore, UpdateChecker } from "./check";

export const updatesModule: Module = {
  name: "updates",
  start(ctx) {
    const compatStore = new FileCompatStore(join(ctx.dataDir, "antigravity-compat.json"), (version, err) => {
      ctx.bus.emit("error", { message: `Antigravity compatibility check failed after agy updated to ${version}: ${err}` });
    });
    const checker = new UpdateChecker(undefined, undefined, ctx.log, compatStore);
    const auto = new AutoUpdater({
      checker,
      looks: () => ctx.loaded?.() ?? [],
      file: join(ctx.dataDir, "auto.json"),
      // What it did goes to the runner's log (and Settings → Updates shows the last result).
      log: ctx.log,
    });
    ctx.ops.register("harnessVersions", async (a) => ({ ...(await checker.report(a?.refresh === true)), auto: auto.status() }));
    ctx.ops.register("harnessUpdate", async (a) => ({ ...(await checker.update(String(a?.id ?? ""))), auto: auto.status() }));
    ctx.ops.register("harnessAutoUpdate", (a) => (typeof a?.on === "boolean" ? auto.set(a.on) : auto.status()));
    const stopAuto = auto.start();
    void checker.report().catch(() => {});
    return stopAuto;
  },
};
