// Claude's TUI screens as tmux captured them (2.1.312): idle at the prompt, or not.
import { expect, test } from "bun:test";
import { claudeScreenIdle } from ".";

const frame = (body: string) => `${body}\n──────────────────\n❯ \n──────────────────\n  Haiku 5.5 | scratch@master | 49k/1m (4%)\n  ⏸ manual mode on\n`;

test("idle at the prompt, after a turn or an interrupt", () => {
  expect(claudeScreenIdle(frame("● pong\n✻ Brewed for 1s · done 12:11 PM"))).toBe(true);
  expect(claudeScreenIdle(frame("❯ Count to 300\n  ⎿  Interrupted · What should Claude do instead?"))).toBe(true);
});

test("working, or a dialog open, is not idle", () => {
  expect(claudeScreenIdle(frame("✽ Shenaniganing… (1s · thinking)"))).toBe(false);
  expect(claudeScreenIdle(frame("✢ Lollygagging… (1m 4s · esc to interrupt)"))).toBe(false);
  expect(claudeScreenIdle(" Do you want to create needs.txt?\n ❯ 1. Yes\n   2. No\n Esc to cancel")).toBe(false);
  expect(claudeScreenIdle("  ❯ 5.  Haiku 5.5 ✔\n  Enter to set as default · s to use this session only · Esc to cancel")).toBe(false);
  expect(claudeScreenIdle("")).toBe(false);
});
