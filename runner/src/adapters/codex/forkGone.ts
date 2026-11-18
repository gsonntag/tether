// A Codex fork reads its history from its original's rollout (fork.ts): removed by hand, the fork
// can't open. The daemon's error, made clear (SPEC §16).

/** The daemon's word when a fork's original rollout was removed (checked in daemon 0.169.1's binary). */
const SOURCE_GONE = /missing source rollout/i;
export const FORK_SOURCE_GONE = "This fork's original history is gone (its Codex rollout was removed).";
/** A clear error for a fork whose original rollout is gone; any other error as it was. */
export const forkError = (e: any): any => (SOURCE_GONE.test(String(e?.message ?? e)) ? new Error(FORK_SOURCE_GONE) : e);

