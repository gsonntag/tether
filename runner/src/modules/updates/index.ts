// Harness updates (Settings → Updates): the harnessVersions and harnessUpdate ops over check.ts,
// and "Update all harnesses when all agents idle" (auto.ts, the harnessAutoUpdate op).

import { join } from "node:path";
import type { Module } from "..";
import { AutoUpdater } from "./auto";
import { FileCompatStore, UpdateChecker } from "./check";
import { SelfUpdater } from "./self";

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
    // The runner's own update: from the checkout this file is in, restarting as SIGTERM stops it.
    const self = new SelfUpdater({
      repo: join(import.meta.dir, "..", "..", "..", ".."),
      looks: () => ctx.loaded?.() ?? [],
      otherBusy: () => auto.busy,
      supported: () => (process.env.INVOCATION_ID ? undefined : "The runner isn't run by systemd, so it can't restart itself."),
      restart: () => process.kill(process.pid, "SIGTERM"),
      file: join(ctx.dataDir, "self.json"),
      log: ctx.log,
    });
    ctx.ops.register("runnerAutoUpdate", (a) => (typeof a?.on === "boolean" ? self.set(a.on) : self.status()));
    let stopSelf: (() => void) | undefined;
    void self.start().then((stop) => (stopSelf = stop));
    void checker.report().catch(() => {});
    return () => {
      stopAuto();
      stopSelf?.();
    };
  },
};
