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
  expect(keyAction(k("Tab"), "terminal", desk)).toBeNull();
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
