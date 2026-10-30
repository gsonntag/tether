// What a key in the message box does (SPEC §9), pure so it is tested without a page.
//
// | state                      | Enter        | Tab (text)  | ⌘/Ctrl+Enter      | Esc (empty) |
// | idle                       | send         | queue (= send now) | send       |             |
// | running, the harness steers| steer        | queue       | stop and send now | stop        |
// | running, no steer          | queue        | queue       | stop and send now | stop        |
// | terminal (TUI drives)      | queue (held for Back to Tether, SPEC §8) | queue |  |
// | shell (the text starts with !) | run the command now, whatever the agent does | — | run |      |
// Shift+Enter is a newline everywhere; on phones Enter is a newline and buttons send.

export type ComposerMode = "idle" | "steer" | "queue" | "terminal" | "shell";
export type ComposerAction = "send" | "steer" | "queue" | "stopSend" | "stop" | "shell" | null;

/** Text that is a `!` command (SPEC §9 Shell commands): it starts with "!". */
export const isShellText = (text: string) => text.trimStart().startsWith("!");
/** The command in `!` text. */
export const shellCommand = (text: string) => text.trimStart().slice(1).trim();
/** The shell toggle: adds the leading "!" or takes it off. */
export const toggleShell = (text: string) => (isShellText(text) ? text.trimStart().slice(1).replace(/^ /, "") : `!${text}`);

export function composerMode(o: { running: boolean; canSteer: boolean; inTerminal: boolean; shell?: boolean }): ComposerMode {
  if (o.shell) return "shell";
  if (o.inTerminal) return "terminal";
  if (!o.running) return "idle";
  return o.canSteer ? "steer" : "queue";
}

/** What Enter (the main button) does in a mode. */
export const primaryAction = (mode: ComposerMode): Exclude<ComposerAction, "stop" | "stopSend" | null> => (mode === "shell" ? "shell" : mode === "steer" ? "steer" : mode === "queue" || mode === "terminal" ? "queue" : "send");

export function keyAction(e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey?: boolean }, mode: ComposerMode, o: { hasText: boolean; phone: boolean }): ComposerAction {
  const busy = mode === "steer" || mode === "queue";
  // A command runs now (Enter or ⌘/Ctrl+Enter); Tab and Esc do nothing special.
  if (mode === "shell") return e.key === "Enter" && !e.shiftKey && o.hasText && (!o.phone || e.metaKey || e.ctrlKey) ? "shell" : null;
  if (e.key === "Enter" && !e.shiftKey) {
    if (e.metaKey || e.ctrlKey) return !o.hasText ? null : busy ? "stopSend" : mode === "terminal" ? "queue" : "send";
    if (o.phone) return null;
    return o.hasText ? primaryAction(mode) : null;
  }
  if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && o.hasText) return "queue";
  if (e.key === "Escape" && busy && !o.hasText) return "stop";
  return null;
}

/** Why a held queue waits, as the shell hint says it (SPEC §9). */
const HELD_HINT: Record<string, string> = {
  stopped: "paused after Stop",
  failed: "paused after a failed turn",
  restart: "paused after a restart",
};

/**
 * When a `!` command's output reaches the agent, as the shell hint says it: it goes through the
 * queue, so it follows whatever holds the queue.
 */
export function shellWhen(agent: string, o: { running: boolean; inTerminal: boolean; heldBy?: string }): string {
  if (o.heldBy === "restartWait") return "the output waits in the queue until Claude Code from before the restart finishes";
  // A queue paused (after Stop, …) stays paused through a terminal round trip: that comes first.
  if (o.heldBy && o.heldBy !== "terminal") return `the output waits in the queue, ${HELD_HINT[o.heldBy] ?? "paused"} (Resume or send something to let it go)`;
  if (o.inTerminal || o.heldBy === "terminal") return `the output goes to ${agent} when you go Back to Tether`;
  return `the output goes to ${agent} ${o.running ? "when this turn ends" : "when it finishes"}`;
}
