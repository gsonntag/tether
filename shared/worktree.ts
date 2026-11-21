// A worktree per session (SPEC §4): New session's "New worktree" makes a git worktree beside the
// repo, on a new branch, and the session runs there; "Existing worktree" starts one in a worktree
// that's already there. Shared by the runner (making it) and the browser (the dialog).

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
      /** what runs in a new worktree before the first message: ".tether/setup", or the config's command (as the base has it) */
      setup?: string;
      /** .tether/setup's text, to show what will run */
      setupText?: string;
      /** setupText is only the script's start */
      setupTextCut?: boolean;
      /**
       * which setup is shown ("" for none): the script's blob id, or a hash of the whole command.
       * newWorktreeSession's `expectSetup`: a "what you saw is what runs" check, not a trust boundary
       */
      setupId: string;
      /** the base is origin's: it's fetched right before the worktree is made; this is when it last was (ms) */
      fetchedAt?: number;
      remote?: boolean;
    };

/** What newWorktreeSession made. */
export interface WorktreeMade {
  sessionId: string;
  path: string;
  branch: string;
  base: string;
  /** the setup it runs (its card shows in the session), if the repo has one */
  setup?: string;
  /** the base was fetched from origin just before (false: the fetch failed, it's as last fetched) */
  fetched?: boolean;
}

/** One of a repo's worktrees, as New session's "Existing worktree" lists it (`listWorktrees`). */
export interface WorktreeEntry {
  path: string;
  /** its branch; none: a detached HEAD */
  branch?: string;
  /** the sessions working in it (not archived): its folder, or recorded as its users */
  sessions: { id: string; title?: string }[];
  /** Tether made it (New worktree): once its work is merged, its last session's check-in removes it */
  tether?: boolean;
}

/** A repo's worktrees other than its main checkout (`listWorktrees`); none outside git. */
export interface WorktreeList {
  /** the repo's main checkout */
  repo?: string;
  worktrees: WorktreeEntry[];
}

/** What existingWorktreeSession started. */
export interface WorktreeJoined {
  sessionId: string;
  path: string;
  branch?: string;
  /** Tether made it (it's removed once merged and no session uses it); else it's never removed by Tether */
  tether?: boolean;
}

/** How the picker shows a worktree: "path · branch · used by N sessions". */
export function worktreeLabel(w: WorktreeEntry): string {
  const n = w.sessions.length;
  return [w.path, w.branch ?? "detached HEAD", n ? `used by ${n} session${n === 1 ? "" : "s"}` : "unused"].join(" · ");
}

/**
 * The worktree `wanted` names: its path (`expand` makes a typed path absolute: ~, trailing
 * slashes), else its branch (refs/heads/ optional), else its folder's name. Undefined: none.
 */
export function pickWorktree<T extends { path: string; branch?: string }>(list: T[], wanted: string, expand: (p: string) => string = (p) => p): T | undefined {
  const w = wanted.trim();
  if (!w) return undefined;
  const trim = (p: string) => p.replace(/\/+$/, "") || "/";
  const path = trim(expand(w));
  const branch = w.replace(/^refs\/heads\//, "");
  return list.find((e) => trim(e.path) === path) ?? list.find((e) => e.branch === branch) ?? list.find((e) => trim(e.path).split("/").pop() === w);
}

/** A new worktree's setup may run this long; then it's stopped, as failed. */
export const SETUP_MAX_MS = 30 * 60_000;

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

/** A slug from a hash of some text with no usable words in it ("wt-3f9a1c"): the same text, the same slug. */
export function hashSlug(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `wt-${h.toString(16).padStart(8, "0").slice(0, 6)}`;
}

/** The folder name for a branch: its slug part ("tether/fix-login" -> "fix-login", "a/b" -> "a-b"). */
export function folderForBranch(branch: string): string {
  const rest = branch.startsWith(WORKTREE_BRANCH_PREFIX) ? branch.slice(WORKTREE_BRANCH_PREFIX.length) : branch;
  return rest.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80) || randomSlug();
}
