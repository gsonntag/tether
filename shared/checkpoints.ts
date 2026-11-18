// Turn checkpoints (SPEC §10 Checkpoints): what the runner's checkpoints keep for a session and send
// to the Changes pane's Turn scope. The snapshots themselves are commits under hidden refs in the
// session's repo; this is their list.

/** One snapshot pair: a turn (before → after), or a restore (the files before it → after it). */
export interface CheckpointInfo {
  /** unique within the session */
  id: string;
  /** the session's count (turns and restores together), as in the ref's name */
  n: number;
  kind: "turn" | "restore";
  /** when the turn (or restore) started, ms */
  at: number;
  endedAt?: number;
  /** a turn: the start of the message that began it */
  prompt?: string;
  /** a turn: the transcript message it began with, when the harness said */
  msgId?: string;
  /** files that differ between before and after (none yet while it runs) */
  files?: number;
  /** no after snapshot (yet): still running, or cut off by a restart. Its diff is against the working tree */
  open?: true;
  /** a restore: the checkpoint whose before it put back */
  to?: string;
  /** a restore: that checkpoint's turn number, for its label */
  toN?: number;
  /** a restore: the paths it left alone, and why */
  skipped?: Skipped[];
  /** a turn: its before snapshot finished well after the turn started, so it may hold the turn's first edits */
  late?: true;
}

/**
 * Why a restore left a path alone: in or is a nested repository; a folder where a file goes; under a
 * symlink, or a file in its folder's place; couldn't be read; ignored by the restored rules; not
 * taken in that snapshot (too big, unreadable, or untracked files weren't taken); not a repo path.
 */
export type SkipReason = "nested" | "folder" | "symlink" | "blocked" | "unreadable" | "ignored" | "notTaken" | "outside";
export interface Skipped {
  path: string;
  why: SkipReason;
}

export interface OtherSession {
  id: string;
  title: string;
  status: "idle" | "running" | "waiting";
}

export interface CheckpointList {
  /** `notRepo`: the folder isn't in a git repo, so nothing is taken */
  state: "ok" | "notRepo";
  root?: string;
  /** newest first */
  checkpoints: CheckpointInfo[];
  /** live sessions in the same repo: a restore changes their files too */
  others: OtherSession[];
  /** why a restore can't run now (this session or another live one in the repo is working, or it has waiting messages) */
  blocked?: string;
}

export interface RestoreResult {
  /** the restore's own checkpoint: its before is the files as they were, to undo it */
  checkpoint: CheckpointInfo;
  written: number;
  removed: number;
  skipped: Skipped[];
}

/** Checkpoints kept per session, at most */
export const CHECKPOINTS_MAX = 200;
/** and for this long */
export const CHECKPOINT_TTL_MS = 14 * 24 * 60 * 60_000;
/** Untracked files bigger than this stay out of snapshots (and so restores leave them alone). */
export const CHECKPOINT_FILE_BYTES_MAX = 32 * 1024 * 1024;

/** A restore streams a big file into a temporary file beside it, named so; snapshots and diffs leave such files out, and the next restore sweeps any a crash left. */
export const RESTORE_TMP_PREFIX = ".tether-restore-";
export const RESTORE_TMP_RE = /^\.tether-restore-[0-9a-f]{12}$/;
/** the pathspec that leaves them out */
export const RESTORE_TMP_EXCLUDE = `:(exclude,glob)**/${RESTORE_TMP_PREFIX}*`;
