// The git module (SPEC §10 Changes): a session folder's git changes for the Changes pane. Reads
// only; anyone who may look at the session may look at its diff. Later git features (commit, push,
// a PR; turn checkpoints) add their ops here, beside gitDiff, on the same runner (run.ts).

import { isDiffScope } from "../../../../shared/gitDiff";
import type { Module } from "..";
import { gitDiff } from "./diff";

export const gitModule: Module = {
  name: "git",
  start(ctx) {
    ctx.ops.register("gitDiff", async ({ sessionId, scope }) => {
      if (!isDiffScope(scope)) throw new Error("Unknown diff scope.");
      const s = ctx.session(sessionId) ?? (await ctx.sessions.open(sessionId));
      return gitDiff(s.summary.projectPath, scope);
    });
  },
};
