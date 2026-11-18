// The git module (SPEC §10 Changes, Git actions): a session folder's git changes for the Changes
// pane, turn checkpoints (../checkpoints, §10 Checkpoints), whose Turn scope gitDiff answers too, and
// the pane header's actions (ops.ts): the branch, Commit, Push, Open PR and the session's PR. Diffs
// only read, but what they read is the folder itself (untracked files' contents too), and the actions
// write to it and its remote, so every op here needs drive access: none may ever be in a view-only
// list (shared/access.ts VIEW_OPS, on the branches that have it).

import { isDiffScope } from "../../../../shared/gitDiff";
import type { Module } from "..";
import { startCheckpoints } from "../checkpoints";
import { gitDiff } from "./diff";
import { Prs } from "./gh";
import { registerActions } from "./ops";

/** What the module may be given instead of the real gh (tests). */
export interface GitModuleOpts {
  ghBin?: () => string | undefined;
}

export function makeGitModule(o: GitModuleOpts = {}): Module {
  return {
    name: "git",
    start(ctx) {
      const { checkpoints, stop } = startCheckpoints(ctx);
      registerActions(ctx, new Prs({ dir: ctx.dataDir, ...(o.ghBin ? { bin: o.ghBin } : {}) }));
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
}

export const gitModule: Module = makeGitModule();
