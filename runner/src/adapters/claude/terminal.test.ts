// Claude's TUI screens as tmux captured them (2.1.312, Haiku): idle at the prompt, working, asking.
import { expect, test } from "bun:test";
import { claudeScreen, claudeScreenIdle } from ".";

const RULE = "─".repeat(73);
const BOX = `${RULE}\n❯ \n${RULE}\n  Haiku 5.5 | scratch@master | 48k/1m (4%) | effort: med | $0.00 11s | 5h 12%…\n  ⏸ manual mode on · ← 2 agents\n                                                                           /rc\n`;
const frame = (body: string) => `${body}\n${BOX}`;
const state = (s: string) => claudeScreen(s).state;

test("idle at the prompt, after a turn or an interrupt", () => {
  expect(claudeScreenIdle(frame("● pong\n✻ Brewed for 1s · done 12:11 PM"))).toBe(true);
  expect(claudeScreenIdle(frame("● Bash(echo hi)\n  ⎿  hi\n● DONE\n✻ Churned for 49s · done 5:50 PM"))).toBe(true);
  expect(claudeScreenIdle(frame("❯ Count to 300\n  ⎿  Interrupted · What should Claude do instead?"))).toBe(true);
  expect(claudeScreenIdle(frame("     … +297 lines (ctrl+o to expand)\n● Printed the numbers 1 through 300."))).toBe(true);
  // Text typed in the box, over two lines.
  expect(state(`● OK\n${RULE}\n❯ Run the shell command sleep 30 with Bash, then reply\n  with just DONE.\n${RULE}\n  Haiku 5.5\n`)).toBe("idle");
});

test("working is never idle: spinners of every form, at 80 columns too (no 'esc to interrupt')", () => {
  // Real captures from review round 3: a PreToolUse hook running, compaction, a bare spinner.
  expect(state(frame("  ⎿  Waiting…\n· Determining… (running PreToolUse hook · 16s · ↓ 213 tokens)"))).toBe("busy");
  expect(state(frame("· Determining… (16s · ↓ 213 tokens)"))).toBe("busy");
  expect(state(frame("✻ Compacting conversation…"))).toBe("busy");
  expect(state(frame("· Determining…"))).toBe("busy");
  expect(state(frame("✽ Shenaniganing… (1s · thinking)"))).toBe("busy");
  expect(state(frame("✢ Lollygagging… (1m 4s · esc to interrupt)"))).toBe("busy");
  // The spinner with a todo list and a tip under it.
  expect(state(frame("✶ Working… (3s)\n  ⎿  ☐ Read the file\n     ☐ Write the answer\n\n  ⎿  Tip: Run /ultrareview for a cloud-based review"))).toBe("busy");
});

test("dialogs ask: a permission prompt, plan approval, the model picker, the trust question", () => {
  expect(state(" Do you want to create falcon.txt?\n ❯ 1. Yes\n   2. Yes, and switch to accept edits (shift+tab)\n   3. No\n Esc to cancel · Tab to amend")).toBe("asking");
  const plan = `● Updated plan\n  ⎿  /plan to preview\n${RULE}\n Ready to code?\n Here is Claude's plan:\n Create hello.txt containing hi.\n${RULE}\n Claude has written up a plan and is ready to execute. Would you like to\n proceed?\n ❯ 1. Yes, and use auto mode\n   2. Yes, manually approve edits\n   3. Tell Claude what to change\n      shift+tab to approve with this feedback\n ctrl+g to edit in Vim · ~/.claude/plans/x.md\n`;
  expect(state(plan)).toBe("asking");
  expect(claudeScreenIdle(plan)).toBe(false);
  expect(state("  ❯ 5.  Haiku 5.5 ✔\n  Enter to set as default · s to use this session only · Esc to cancel")).toBe("asking");
  expect(state(" Do you trust the files in this folder?\n ❯ 1. Yes, I trust this folder\n   2. No, exit\n Enter to confirm · Esc to cancel")).toBe("asking");
});

test("a question in Claude's reply, above the prompt box, isn't a dialog", () => {
  expect(state(frame("● Done. Would you like me to add tests too?\n✻ Baked for 2s · done 1:00 PM"))).toBe("idle");
});

test("anything else is unknown, never idle", () => {
  expect(state("")).toBe("unknown");
  expect(state(" ▐▛███▜▌   Claude Code v2.1.312\n")).toBe("unknown");
  expect(state("Transcript view · ctrl+o to toggle")).toBe("unknown");
});

// Whole screens tmux captured from Claude 2.1.312 in P3 review round 4; the name says what they show.
import { readdirSync, readFileSync } from "node:fs";
const SCREENS = `${import.meta.dir}/screens`;
for (const f of readdirSync(SCREENS)) {
  const want = f.split(".").at(-2);
  test(`real screen ${f}: ${want}`, () => {
    expect(state(readFileSync(`${SCREENS}/${f}`, "utf8"))).toBe(want as any);
  });
}

test("a line of an answer or a prompt holding a … is no spinner", () => {
  expect(state(frame("● - first item…\n  - second item…\n  - Let me think…\n✻ Sautéed for 2s · done 6:38 PM"))).toBe("idle");
  expect(state(frame("❯ Quick one… reply with just the word hi.\n● hi"))).toBe("idle");
  expect(state(frame("● Quick one… reply with…"))).toBe("idle");
  // The spinner's tail may wrap at narrow widths.
  expect(state(frame("✻ Ebbing… (running SessionStart hooks… 0/3 ·\n0s)"))).toBe("busy");
});

test("what is typed in the box", () => {
  expect(claudeScreen(`● OK\n${RULE}\n❯ Run the shell command sleep 30 with Bash, then reply\n  with just DONE.\n${RULE}\n`).input).toBe("Run the shell command sleep 30 with Bash, then reply\nwith just DONE.");
  expect(claudeScreen(frame("● OK")).input).toBe("");
});
