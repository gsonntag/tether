import { expect, test } from "bun:test";
import { composerMode, keyAction } from "./composerKeys";

const k = (key: string, m: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) => ({ key, shiftKey: false, metaKey: false, ctrlKey: false, ...m });
const desk = { hasText: true, phone: false };

test("Enter sends when idle, steers when the harness can, else queues", () => {
  expect(keyAction(k("Enter"), composerMode({ running: false, canSteer: true, inTerminal: false }), desk)).toBe("send");
  expect(keyAction(k("Enter"), composerMode({ running: true, canSteer: true, inTerminal: false }), desk)).toBe("steer");
  expect(keyAction(k("Enter"), composerMode({ running: true, canSteer: false, inTerminal: false }), desk)).toBe("queue");
  expect(keyAction(k("Enter"), composerMode({ running: true, canSteer: true, inTerminal: true }), desk)).toBe("send");
  expect(keyAction(k("Enter", { shiftKey: true }), "steer", desk)).toBeNull();
  expect(keyAction(k("Enter"), "idle", { ...desk, hasText: false })).toBeNull();
});

test("Tab queues text; ⌘/Ctrl+Enter stops and sends now; Esc on an empty box stops", () => {
  expect(keyAction(k("Tab"), "steer", desk)).toBe("queue");
  expect(keyAction(k("Tab"), "idle", desk)).toBe("queue");
  expect(keyAction(k("Tab"), "steer", { ...desk, hasText: false })).toBeNull();
  // While the TUI drives, Tab queues for Back to Tether (SPEC §8).
  expect(keyAction(k("Tab"), "terminal", desk)).toBe("queue");
  expect(keyAction(k("Enter", { metaKey: true }), "steer", desk)).toBe("stopSend");
  expect(keyAction(k("Enter", { ctrlKey: true }), "queue", desk)).toBe("stopSend");
  expect(keyAction(k("Enter", { ctrlKey: true }), "idle", desk)).toBe("send");
  expect(keyAction(k("Escape"), "steer", { ...desk, hasText: false })).toBe("stop");
  expect(keyAction(k("Escape"), "steer", desk)).toBeNull();
  expect(keyAction(k("Escape"), "idle", { ...desk, hasText: false })).toBeNull();
});

test("on phones Enter is a newline", () => {
  expect(keyAction(k("Enter"), "idle", { hasText: true, phone: true })).toBeNull();
});

test("! text is a shell command: Enter runs it now, even mid-turn; the toggle adds and removes the !", async () => {
  const { isShellText, shellCommand, toggleShell } = await import("./composerKeys");
  const m = composerMode({ running: true, canSteer: true, inTerminal: false, shell: true });
  expect(m).toBe("shell");
  expect(keyAction(k("Enter"), m, desk)).toBe("shell");
  expect(keyAction(k("Enter", { metaKey: true }), m, desk)).toBe("shell");
  expect(keyAction(k("Tab"), m, desk)).toBeNull();
  expect(keyAction(k("Escape"), m, { ...desk, hasText: false })).toBeNull();
  expect(keyAction(k("Enter"), m, { hasText: true, phone: true })).toBeNull();
  expect(isShellText("  !ls")).toBe(true);
  expect(isShellText("ls !")).toBe(false);
  expect(shellCommand("! npm test ")).toBe("npm test");
  expect(toggleShell("npm test")).toBe("!npm test");
  expect(toggleShell("!npm test")).toBe("npm test");
  expect(toggleShell("")).toBe("!");
});
