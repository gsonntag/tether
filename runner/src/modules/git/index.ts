// The git module (SPEC §10 Changes): a session folder's git changes for the Changes pane. It only
// reads, but what it reads is the folder itself (untracked files' contents too), so it needs drive
// access: it must never be in shared/access.ts VIEW_OPS. Later git features (commit, push,
// a PR; turn checkpoints) add their ops here, beside gitDiff, on the same runner (run.ts).

import { isDiffScope } from "../../../../shared/gitDiff";
import type { Module } from "..";
import { gitDiff } from "./diff";

export const gitModule: Module = {
  name: "git",
  start(ctx) {
    ctx.ops.register("gitDiff", async ({ sessionId, scope }) => {
      if (typeof sessionId !== "string" || !sessionId) throw new Error("sessionId is required.");
      if (!isDiffScope(scope)) throw new Error("Unknown diff scope.");
      const s = ctx.session(sessionId) ?? (await ctx.sessions.open(sessionId));
      return gitDiff(s.summary.projectPath, scope);
    });
  },
};
