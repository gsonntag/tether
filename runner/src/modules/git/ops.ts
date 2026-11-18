// The git actions' ops (SPEC §10 Git actions): gitStatus, gitPr, gitDraft, gitCommit, gitPush and
// gitOpenPr. Actions in one folder run one at a time. Commit is refused while the session's turn runs
// (its edits would land half-made in the commit). Generated text (gitDraft) is a one-shot side query on
// the session's own harness and source (SessionActions.ask): it never blocks committing, and a failure
// is a note under an empty box. Open PR pushes first when the branch isn't pushed or is ahead.

import type { GitActionResult, GitDraft, PrLookup } from "../../../../shared/gitActions";
import type { ModuleContext } from "..";
import { commit, gitStatus, push } from "./actions";
import { COMMIT_SYSTEM, commitPrompt, DRAFT_MS, draftOf, PR_SYSTEM, prPrompt } from "./draft";
import type { Prs } from "./gh";

export function registerActions(ctx: ModuleContext, prs: Prs) {
  const look = async (sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId) throw new Error("sessionId is required.");
    return ctx.session(sessionId) ?? (await ctx.sessions.open(sessionId));
  };
  const chains = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, f: () => Promise<T>): Promise<T> => {
    const run = (chains.get(key) ?? Promise.resolve()).then(f, f);
    const tail = run.catch(() => {});
    chains.set(key, tail);
    void tail.then(() => chains.get(key) === tail && chains.delete(key));
    return run;
  };
  const drafting = new Map<string, Promise<GitDraft>>();

  ctx.ops.register("gitStatus", async ({ sessionId }) => gitStatus((await look(sessionId)).summary.projectPath));

  ctx.ops.register("gitPr", async ({ sessionId, fresh }): Promise<PrLookup> => {
    const s = await look(sessionId);
    const st = await gitStatus(s.summary.projectPath);
    if (st.state !== "ok" || !st.root) return { gh: "noRemote", at: Date.now() };
    return prs.lookup(s.summary.id, { root: st.root, branch: st.branch, defaultBranch: st.defaultBranch, origin: st.origin }, fresh === true);
  });

  ctx.ops.register("gitDraft", async ({ sessionId, kind }) => {
    if (kind !== "commit" && kind !== "pr") throw new Error("Unknown draft.");
    const s = await look(sessionId);
    const key = `${s.summary.id}\0${kind}`;
    const had = drafting.get(key);
    if (had) return had;
    const run = (async (): Promise<GitDraft> => {
      const ask = ctx.sessions.ask;
      if (!ask) return { note: "This runner can't generate text." };
      const p = kind === "commit" ? await commitPrompt(s.summary.projectPath) : await prPrompt(s.summary.projectPath);
      if (!p.prompt) return { note: p.note ?? "Nothing to write about." };
      try {
        return draftOf(kind, await ask(s.summary.id, p.prompt, { system: kind === "commit" ? COMMIT_SYSTEM : PR_SYSTEM, timeoutMs: DRAFT_MS }));
      } catch (e) {
        ctx.log(`git draft ${s.summary.id}: ${(e as Error).message}`);
        return { note: `Couldn't generate one: ${(e as Error).message}` };
      }
    })().finally(() => drafting.delete(key));
    drafting.set(key, run);
    return run;
  });

  ctx.ops.register("gitCommit", async ({ sessionId, message, onDefault }): Promise<GitActionResult> => {
    const s = await look(sessionId);
    if (typeof message !== "string") throw new Error("message is required.");
    const folder = s.summary.projectPath;
    return serial(folder, async () => {
      if ((ctx.session(s.summary.id) ?? s).status === "running") return { ok: false, error: "The session is working. Commit when its turn ends.", status: await gitStatus(folder) };
      const r = await commit(folder, message, onDefault === true);
      if (r.ok) ctx.log(`${s.summary.id}: committed ${r.commit ?? ""} on ${r.status.branch ?? "?"}`);
      return r;
    });
  });

  ctx.ops.register("gitPush", async ({ sessionId }) => {
    const s = await look(sessionId);
    const r = await serial(s.summary.projectPath, () => push(s.summary.projectPath));
    prs.forget(s.summary.id);
    return r;
  });

  ctx.ops.register("gitOpenPr", async ({ sessionId, title, body }): Promise<GitActionResult> => {
    const s = await look(sessionId);
    if (typeof title !== "string" || typeof body !== "string") throw new Error("title and body are required.");
    const folder = s.summary.projectPath;
    return serial(folder, async () => {
      let st = await gitStatus(folder);
      const no = (error: string): GitActionResult => ({ ok: false, error, status: st });
      if (st.state !== "ok" || !st.root) return no("This folder isn't in a git repository.");
      if (!title.trim()) return no("Write a title first.");
      if (!st.branch) return no("HEAD is detached: check out a branch to open a PR from.");
      if (!st.defaultBranch) return no("There's no default branch to open a PR against.");
      if (st.branch === st.defaultBranch) return no(`This is ${st.branch}, the default branch: a PR needs another branch.`);
      if (!st.origin) return no("There's no remote called origin.");
      if (!prs.bin()) return no("gh isn't installed on this computer. Install GitHub's gh and run gh auth login there.");
      if (!st.upstream || st.ahead > 0) {
        const p = await push(folder);
        if (!p.ok) return p;
        st = p.status;
      }
      const r = await prs.create(s.summary.id, st.root!, { base: st.defaultBranch!, head: st.branch!, title: title.trim(), body });
      if (r.pr) ctx.log(`${s.summary.id}: PR #${r.pr.number} ${r.pr.url}`);
      return { ok: !r.error, ...(r.error ? { error: r.error } : {}), ...(r.output ? { output: r.output } : {}), ...(r.pr ? { pr: r.pr } : {}), status: st };
    });
  });
}
