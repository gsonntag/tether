import type { HarnessId } from "./shared/protocol";

/** Harnesses whose adapter has no steer(): a message sent while running waits for the turn's end. */
const CANT_STEER: ReadonlySet<HarnessId> = new Set<HarnessId>(["opencode", "kiro", "antigravity"]);
export const canSteer = (h: HarnessId) => !CANT_STEER.has(h);

export type ComposerKey = {
  key: string;
  shift?: boolean;
  alt?: boolean;
  /** ⌘ on Mac, Ctrl elsewhere (either counts) */
  mod?: boolean;
  /** an IME composition is in progress */
  composing?: boolean;
};

export type ComposerContext = {
  running: boolean;
  steerable: boolean;
  /** Bash mode ("!cmd") */
  shell: boolean;
  /** phone layout: Enter is a new line */
  narrow: boolean;
  text: string;
};

/** What a key does in the message box (after the `/` menu and history recall had their turn);
 *  null leaves the key to the browser. */
export type ComposerKeyAction = "steer" | "followUp" | "force" | "newline" | "stop";

export function composerKeyAction(k: ComposerKey, c: ComposerContext): ComposerKeyAction | null {
  const plain = !k.shift && !k.alt && !k.mod && !k.composing;
  const canQueue = c.running && c.steerable && !c.shell;
  if (k.key === "Escape") return !k.composing && c.running && !c.text ? "stop" : null;
  // Tab queues only with words to queue; otherwise it moves focus as usual.
  if (k.key === "Tab") return plain && canQueue && c.text.trim() ? "followUp" : null;
  if (k.key !== "Enter" || k.shift || k.composing) return null;
  if (k.mod) return c.running && !c.shell ? "force" : "steer";
  if (c.narrow) return "newline";
  return k.alt && canQueue ? "followUp" : "steer";
}

/** With the `/` menu open: Tab completes; Enter (with or without ⌘/Ctrl) completes a partial
 *  name and sends an exact one. */
export const completesSlash = (k: ComposerKey, exact: boolean) => k.key === "Tab" || (k.key === "Enter" && !k.shift && !exact);

/** Time left in timed full access, for the trigger: whole minutes left, "<1m" in the last one. */
export function fullAccessLeft(ms: number): string {
  return ms < 60_000 ? "<1m" : `${Math.floor(ms / 60_000)}m`;
}
