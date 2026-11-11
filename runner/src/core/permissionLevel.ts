// How far a session's permission mode lets its agent go without asking, on the one scale every
// harness shares (shared/move.ts LEVELS): Claude's plan < default < acceptEdits < auto <
// bypassPermissions, Codex's read-only < untrusted < auto (workspace-write) < full-access. Move
// maps modes with it (SPEC §15); peers holds a message from a stricter session to a looser one
// (SPEC §9a).

import { LEVELS, type Level } from "../../../shared/move";
import type { Adapter } from "./adapter";

/** A mode's level on its harness; anything it can't place is unknown (undefined). */
export function levelOf(a: Adapter | undefined, mode: string | undefined): Level | undefined {
  if (!mode || !a?.move) return undefined;
  return a.move.modes.find((m) => m.mode === mode)?.level ?? a.move.levelOf?.(mode);
}

/** A level as an agent reads it. */
export const LEVEL_WORDS: Record<Level, string> = {
  [LEVELS.readOnly]: "read only",
  [LEVELS.ask]: "asks before edits and commands",
  [LEVELS.edits]: "edits without asking, asks for commands",
  [LEVELS.sandboxed]: "edits and runs commands in its folder without asking",
  [LEVELS.judged]: "decides itself what needs asking",
  [LEVELS.full]: "full access, never asks",
};
