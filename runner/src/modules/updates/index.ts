// Harness updates (Settings → Updates): the harnessVersions and harnessUpdate ops over check.ts.

import type { Module } from "..";
import { UpdateChecker } from "./check";

/** The runner's checker: the Home agent's check_harness_updates reads the same cache. */
export let updateChecker: UpdateChecker | undefined;

export const updatesModule: Module = {
  name: "updates",
  start(ctx) {
    const checker = new UpdateChecker(undefined, undefined, ctx.log);
    updateChecker = checker;
    ctx.ops.register("harnessVersions", (a) => checker.report(a?.refresh === true));
    ctx.ops.register("harnessUpdate", (a) => checker.update(String(a?.id ?? "")));
    return () => {
      if (updateChecker === checker) updateChecker = undefined;
    };
  },
};
