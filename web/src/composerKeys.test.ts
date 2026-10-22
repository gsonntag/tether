import { describe, expect, test } from "bun:test";
import { canSteer, completesSlash, composerKeyAction, fullAccessLeft, type ComposerContext } from "./composerKeys";

const idle: ComposerContext = { running: false, steerable: true, shell: false, narrow: false, text: "hi" };
const running: ComposerContext = { ...idle, running: true };

describe("composer keys (SPEC piece B table)", () => {
  test("Enter sends when idle and steers while running", () => {
    expect(composerKeyAction({ key: "Enter" }, idle)).toBe("steer");
    expect(composerKeyAction({ key: "Enter" }, running)).toBe("steer");
  });
  test("Tab queues only while running, steerable, with text, no modifiers, not in Bash mode", () => {
    expect(composerKeyAction({ key: "Tab" }, running)).toBe("followUp");
    expect(composerKeyAction({ key: "Tab" }, idle)).toBeNull();
    expect(composerKeyAction({ key: "Tab" }, { ...running, text: "  " })).toBeNull();
    expect(composerKeyAction({ key: "Tab" }, { ...running, steerable: false })).toBeNull();
    expect(composerKeyAction({ key: "Tab" }, { ...running, shell: true })).toBeNull();
    expect(composerKeyAction({ key: "Tab", shift: true }, running)).toBeNull();
    expect(composerKeyAction({ key: "Tab", composing: true }, running)).toBeNull();
  });
  test("⌘/Ctrl+Enter stops and sends now while running, sends when idle or in Bash mode", () => {
    expect(composerKeyAction({ key: "Enter", mod: true }, running)).toBe("force");
    expect(composerKeyAction({ key: "Enter", mod: true }, idle)).toBe("steer");
    expect(composerKeyAction({ key: "Enter", mod: true }, { ...running, shell: true })).toBe("steer");
    // Phones too: ⌘Enter on a hardware keyboard still sends.
    expect(composerKeyAction({ key: "Enter", mod: true }, { ...running, narrow: true })).toBe("force");
  });
  test("Shift+Enter and a composing Enter stay the browser's (new line, IME)", () => {
    expect(composerKeyAction({ key: "Enter", shift: true }, running)).toBeNull();
    expect(composerKeyAction({ key: "Enter", composing: true }, running)).toBeNull();
  });
  test("Alt+Enter queues while running (the old key), else sends", () => {
    expect(composerKeyAction({ key: "Enter", alt: true }, running)).toBe("followUp");
    expect(composerKeyAction({ key: "Enter", alt: true }, idle)).toBe("steer");
    expect(composerKeyAction({ key: "Enter", alt: true }, { ...running, steerable: false })).toBe("steer");
  });
  test("phones: Enter is a new line", () => {
    expect(composerKeyAction({ key: "Enter" }, { ...running, narrow: true })).toBe("newline");
    expect(composerKeyAction({ key: "Enter" }, { ...idle, narrow: true })).toBe("newline");
  });
  test("Esc stops a running agent only from an empty box", () => {
    expect(composerKeyAction({ key: "Escape" }, { ...running, text: "" })).toBe("stop");
    expect(composerKeyAction({ key: "Escape" }, running)).toBeNull();
    expect(composerKeyAction({ key: "Escape" }, { ...idle, text: "" })).toBeNull();
    expect(composerKeyAction({ key: "Escape", composing: true }, { ...running, text: "" })).toBeNull();
  });
  test("other keys are left alone", () => {
    expect(composerKeyAction({ key: "a" }, running)).toBeNull();
  });
});

describe("the / menu", () => {
  test("Tab completes; Enter (with or without ⌘/Ctrl) completes a partial name and sends an exact one", () => {
    expect(completesSlash({ key: "Tab" }, true)).toBe(true);
    expect(completesSlash({ key: "Enter" }, false)).toBe(true);
    expect(completesSlash({ key: "Enter", mod: true }, false)).toBe(true);
    expect(completesSlash({ key: "Enter" }, true)).toBe(false);
    expect(completesSlash({ key: "Enter", shift: true }, false)).toBe(false);
  });
});

describe("steering", () => {
  test("opencode, Kiro and Antigravity can't steer", () => {
    expect(canSteer("claude-code")).toBe(true);
    expect(canSteer("codex")).toBe(true);
    expect(canSteer("pi")).toBe(true);
    expect(canSteer("opencode")).toBe(false);
    expect(canSteer("kiro")).toBe(false);
    expect(canSteer("antigravity")).toBe(false);
  });
});

describe("timed full access", () => {
  test("whole minutes left, <1m in the last minute", () => {
    expect(fullAccessLeft(15 * 60_000)).toBe("15m");
    expect(fullAccessLeft(14 * 60_000 + 59_000)).toBe("14m");
    expect(fullAccessLeft(60_000)).toBe("1m");
    expect(fullAccessLeft(59_999)).toBe("<1m");
    expect(fullAccessLeft(0)).toBe("<1m");
  });
});
