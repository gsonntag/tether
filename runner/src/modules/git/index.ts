// The git module (SPEC §10 Changes): a session folder's git changes for the Changes pane, and turn
// checkpoints (../checkpoints, §10 Checkpoints), whose Turn scope gitDiff answers too. Diffs only
// read, but what they read is the folder itself (untracked files' contents too), so they need drive
// access: gitDiff, checkpoints and restoreCheckpoint must never be in shared/access.ts VIEW_OPS.
// Later git features (commit, push, a PR) add their ops here, beside gitDiff (run.ts).

import { isDiffScope } from "../../../../shared/gitDiff";
import type { Module } from "..";
import { startCheckpoints } from "../checkpoints";
import { gitDiff } from "./diff";

export const gitModule: Module = {
  name: "git",
  start(ctx) {
    const { checkpoints, stop } = startCheckpoints(ctx);
    ctx.ops.register("gitDiff", async ({ sessionId, scope, checkpoint }) => {
      if (typeof sessionId !== "string" || !sessionId) throw new Error("sessionId is required.");
      if (!isDiffScope(scope)) throw new Error("Unknown diff scope.");
      if (scope === "turn") return checkpoints.diff(sessionId, typeof checkpoint === "string" ? checkpoint : undefined);
      const s = ctx.session(sessionId) ?? (await ctx.sessions.open(sessionId));
      return gitDiff(s.summary.projectPath, scope);
    });
    return stop;
  },
};
