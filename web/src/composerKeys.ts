// What a key in the message box does (SPEC §9), pure so it is tested without a page.
//
// | state                      | Enter        | Tab (text)  | ⌘/Ctrl+Enter      | Esc (empty) |
// | idle                       | send         | queue (= send now) | send       |             |
// | running, the harness steers| steer        | queue       | stop and send now | stop        |
// | running, no steer          | queue        | queue       | stop and send now | stop        |
// | terminal (TUI drives)      | send (typed into the TUI) | queue (held for Back to Tether, SPEC §8) |  |
// Shift+Enter is a newline everywhere; on phones Enter is a newline and buttons send.

export type ComposerMode = "idle" | "steer" | "queue" | "terminal";
export type ComposerAction = "send" | "steer" | "queue" | "stopSend" | "stop" | null;

export function composerMode(o: { running: boolean; canSteer: boolean; inTerminal: boolean }): ComposerMode {
  if (o.inTerminal) return "terminal";
  if (!o.running) return "idle";
  return o.canSteer ? "steer" : "queue";
}

/** What Enter (the main button) does in a mode. */
export const primaryAction = (mode: ComposerMode): Exclude<ComposerAction, "stop" | "stopSend" | null> => (mode === "steer" ? "steer" : mode === "queue" ? "queue" : "send");

export function keyAction(e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey?: boolean }, mode: ComposerMode, o: { hasText: boolean; phone: boolean }): ComposerAction {
  const busy = mode === "steer" || mode === "queue";
  if (e.key === "Enter" && !e.shiftKey) {
    if (e.metaKey || e.ctrlKey) return !o.hasText ? null : busy ? "stopSend" : "send";
    if (o.phone) return null;
    return o.hasText ? primaryAction(mode) : null;
  }
  if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && o.hasText) return "queue";
  if (e.key === "Escape" && busy && !o.hasText) return "stop";
  return null;
}
