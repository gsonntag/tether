// Cross-harness subagents (runner/src/crossAgents.ts): what the runner and the web app both need.

import { GUARD_MODES, type GuardMode } from "./protocol";

/** How a subagent's first message starts: the transcript folds the instructions around its task. */
export const SUBAGENT_TASK_PREFIX = "You are a subagent:";

/** How Tether's messages about a subagent start in the parent's conversation (finished, failed, stopped). */
export const SUBAGENT_NOTE_PREFIX = "[Tether] Subagent";

/** A subagent may start one more level of subagents, no deeper. */
export const MAX_SUBAGENT_DEPTH = 2;

/** At most this many subagents run at once in one tree (a top-level session and everything under it). */
export const MAX_RUNNING_SUBAGENTS = 4;

/** Strictest first: ask, edits, auto, full. */
export const guardRank = (g: GuardMode) => GUARD_MODES.findIndex((m) => m.id === g);

/** Whether `child` gives no more permission than `parent`. */
export const guardWithin = (child: GuardMode, parent: GuardMode) => guardRank(child) <= guardRank(parent);
