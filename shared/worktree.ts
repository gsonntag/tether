// A worktree per session (SPEC §4): New session's "New worktree" makes a git worktree beside the
// repo, on a new branch, and the session runs there. Shared by the runner (making it) and the
// browser (the dialog).

/** New worktrees' branches start with this. */
export const WORKTREE_BRANCH_PREFIX = "tether/";
/** A slug is at most this long (the folder's name, and the branch's after the prefix). */
export const SLUG_MAX = 40;

/** What New session's Workspace choice needs to know about a folder (`workspaceInfo`). */
export type WorkspaceInfo =
  | { git: false }
  | {
      git: true;
      /** the repo's main checkout */
      repo: string;
      /** where a new worktree starts: origin's default branch (origin/main), else main or master, else HEAD */
      base: string;
      /** a branch a new worktree would get now, and its folder */
      branch: string;
      path: string;
      /** what runs in a new worktree before the first message: ".tether/setup", or the config's command */
      setup?: string;
    };

/** What newWorktreeSession made. */
export interface WorktreeMade {
  sessionId: string;
  path: string;
  branch: string;
  base: string;
  /** the setup it runs (its card shows in the session), if the repo has one */
  setup?: string;
}

const WORDS_MAX = 6;
const FILLER = new Set(["a", "an", "the", "please", "can", "could", "you", "would", "to", "of", "and", "in", "on", "for", "with", "i", "we", "it", "this", "that", "is", "be", "me", "my", "our"]);

/**
 * A short folder- and branch-safe slug from some text (a first message, a title): its first few
 * meaningful words, lowercase ASCII letters, digits and dashes. Empty when nothing usable is left.
 */
export function slugOf(text: string): string {
  const words = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const kept = words.filter((w) => !FILLER.has(w));
  const pick = (kept.length ? kept : words).slice(0, WORDS_MAX);
  let slug = "";
  for (const w of pick) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > SLUG_MAX) break;
    slug = next;
  }
  return slug || (pick[0] ?? "").slice(0, SLUG_MAX);
}

/** A short random slug ("wt-k3x9p2"), for a session with nothing to name it by. */
export function randomSlug(): string {
  return `wt-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
}

/** The folder name for a branch: its slug part ("tether/fix-login" -> "fix-login", "a/b" -> "a-b"). */
export function folderForBranch(branch: string): string {
  const rest = branch.startsWith(WORKTREE_BRANCH_PREFIX) ? branch.slice(WORKTREE_BRANCH_PREFIX.length) : branch;
  return rest.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80) || randomSlug();
}
