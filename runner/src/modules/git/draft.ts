// Generated text for Commit and Open PR (SPEC §10 Git actions): what the model is shown and asked. A
// commit's: the tracked changes against HEAD (cut short), the names of untracked files (never their
// contents) and the recent commit subjects, for the repo's style. A PR's: its commits since the
// merge base with the default branch, their summary and diff (cut short). The asking itself is the
// session's harness, on its own source (SessionActions.ask): never a turn in its transcript.

import { cleanMessage, splitTitleBody, type GitDraft } from "../../../../shared/gitActions";
import { defaultBranch, repoRoot } from "./diff";
import { git } from "./run";

/** Diff text shown to the model at most (characters). */
export const DRAFT_DIFF_MAX = 12_000;
const LOG_MAX = 4_000;
const UNTRACKED_MAX = 60;
export const DRAFT_MS = 45_000;

const DIFF = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative"];
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n[… cut: ${s.length - max} more characters]` : s);
const opt = { ok: [0, 1, 128], maxBytes: 256 * 1024 };

export const COMMIT_SYSTEM = "You write git commit messages. Answer with the commit message only: no preamble, no code fences, no quotes.";
export const PR_SYSTEM = "You write GitHub pull request titles and descriptions. Answer with the title on the first line, a blank line, then the description in Markdown. No preamble, no code fences.";

/** The commit prompt, or a note why there's nothing to write about. */
export async function commitPrompt(cwd: string): Promise<{ prompt?: string; note?: string }> {
  const root = await repoRoot(cwd);
  if (!root) return { note: "This folder isn't in a git repository." };
  const hasHead = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], opt)).code === 0;
  const [log, stat, diff, untracked] = await Promise.all([
    hasHead ? git(root, ["log", "-n", "15", "--format=%s"], opt) : undefined,
    hasHead ? git(root, [...DIFF, "--stat=120", "HEAD"], opt) : git(root, [...DIFF, "--cached", "--stat=120"], opt),
    hasHead ? git(root, [...DIFF, "HEAD"], opt) : git(root, [...DIFF, "--cached"], opt),
    git(root, ["ls-files", "--others", "--exclude-standard"], opt),
  ]);
  const fresh = untracked.out.split("\n").filter(Boolean);
  if (!diff.out.trim() && !fresh.length) return { note: "Nothing to commit." };
  const parts = [
    "Write a commit message for these changes.",
    "A subject line under 72 characters; then, only if it helps, a blank line and a short body (wrapped at 72) saying what changed and why.",
    log?.out.trim() ? `Match the style of this repository's recent commit subjects:\n${log.out.trim()}` : "",
    stat.out.trim() ? `Changed files:\n${stat.out.trim()}` : "",
    fresh.length ? `New files:\n${fresh.slice(0, UNTRACKED_MAX).join("\n")}${fresh.length > UNTRACKED_MAX ? `\n(and ${fresh.length - UNTRACKED_MAX} more)` : ""}` : "",
    diff.out.trim() ? `The diff:\n${cut(diff.out, DRAFT_DIFF_MAX)}` : "",
  ];
  return { prompt: parts.filter(Boolean).join("\n\n") };
}

/** The PR prompt, or a note why there's nothing to write about. */
export async function prPrompt(cwd: string): Promise<{ prompt?: string; note?: string }> {
  const root = await repoRoot(cwd);
  if (!root) return { note: "This folder isn't in a git repository." };
  const def = await defaultBranch(root);
  if (!def) return { note: "No default branch to open a PR against." };
  const mb = (await git(root, ["merge-base", "HEAD", def], opt)).out.trim();
  if (!mb) return { note: `This branch has no history in common with ${def}.` };
  const [log, stat, diff] = await Promise.all([
    git(root, ["log", "--reverse", "--format=- %s%n%b", `${mb}..HEAD`], opt),
    git(root, [...DIFF, "--stat=120", mb, "HEAD"], opt),
    git(root, [...DIFF, mb, "HEAD"], opt),
  ]);
  if (!log.out.trim()) return { note: `No commits on this branch beyond ${def}.` };
  const parts = [
    "Write a pull request title and description for this branch.",
    "The title under 72 characters. The description: a short summary, then the main changes as a few bullets; how it was tested if the commits say.",
    `Its commits:\n${cut(log.out.trim(), LOG_MAX)}`,
    `Changed files:\n${stat.out.trim()}`,
    `The diff:\n${cut(diff.out, DRAFT_DIFF_MAX)}`,
  ];
  return { prompt: parts.join("\n\n") };
}

/** A draft from what the model answered. */
export function draftOf(kind: "commit" | "pr", answer: string): GitDraft {
  if (kind === "commit") {
    const message = cleanMessage(answer);
    return message ? { message } : { note: "The model's answer was empty." };
  }
  const { title, body } = splitTitleBody(answer);
  return title ? { title, body } : { note: "The model's answer was empty." };
}
