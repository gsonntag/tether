// Harness updates (Settings → Updates): the harnessVersions and harnessUpdate ops over check.ts,
// and "Update all harnesses when all agents idle" (auto.ts, the harnessAutoUpdate op).

import { join } from "node:path";
import { FROM_TETHER } from "../../../../shared/fromTether";
import type { Module } from "..";
import { AutoUpdater } from "./auto";
import { UpdateChecker } from "./check";

/** The runner's checker: the Home agent's check_harness_updates reads the same cache. */
export let updateChecker: UpdateChecker | undefined;

export const updatesModule: Module = {
  name: "updates",
  start(ctx) {
    const checker = new UpdateChecker(undefined, undefined, ctx.log);
    updateChecker = checker;
    const auto = new AutoUpdater({
      checker,
      looks: () => ctx.loaded?.() ?? [],
      file: join(ctx.dataDir, "auto.json"),
      log: ctx.log,
      // The Home agent's current chat hears it and tells the person.
      notify: async (text) => {
        const home = await ctx.ops.call("homeAgent", {}).catch(() => undefined);
        if (home?.sessionId) await ctx.sessions.queue(home.sessionId, `${FROM_TETHER}${text}\nTell the person in one short sentence.`);
      },
    });
    ctx.ops.register("harnessVersions", async (a) => ({ ...(await checker.report(a?.refresh === true)), auto: auto.status() }));
    ctx.ops.register("harnessUpdate", async (a) => ({ ...(await checker.update(String(a?.id ?? ""))), auto: auto.status() }));
    ctx.ops.register("harnessAutoUpdate", (a) => (typeof a?.on === "boolean" ? auto.set(a.on) : auto.status()));
    const stopAuto = auto.start();
    return () => {
      stopAuto();
      if (updateChecker === checker) updateChecker = undefined;
    };
  },
};
