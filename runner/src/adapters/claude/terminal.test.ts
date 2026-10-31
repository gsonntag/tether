// Claude's TUI screens as tmux captured them (2.1.312, Haiku): idle at the prompt, working, asking.
import { expect, test } from "bun:test";
import { claudeScreen } from ".";
const claudeScreenIdle = (s: string) => claudeScreen(s).state === "idle";

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

test("questions ask: a permission prompt, plan approval, the trust question", () => {
  expect(state(`${RULE}\n Do you want to create falcon.txt?\n ❯ 1. Yes\n   2. Yes, and switch to accept edits (shift+tab)\n   3. No\n Esc to cancel · Tab to amend`)).toBe("asking");
  const plan = `● Updated plan\n  ⎿  /plan to preview\n${RULE}\n Ready to code?\n Here is Claude's plan:\n Create hello.txt containing hi.\n${RULE}\n Claude has written up a plan and is ready to execute. Would you like to\n proceed?\n ❯ 1. Yes, and use auto mode\n   2. Yes, manually approve edits\n   3. Tell Claude what to change\n      shift+tab to approve with this feedback\n ctrl+g to edit in Vim · ~/.claude/plans/x.md\n`;
  expect(state(plan)).toBe("asking");
  expect(claudeScreenIdle(plan)).toBe(false);
  // Claude's own menus are pickers: they block typing but ask nobody anything.
  expect(state("  ❯ 5.  Haiku 5.5 ✔\n  Enter to set as default · s to use this session only · Esc to cancel")).toBe("picker");
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

test("what is typed in the box is only typed: a numbered line, a list, dialog words, never a dialog", () => {
  for (const typed of ["1. Reply with just the word ONE.", "2) Reply with just THREE.", "Steps:\n  1. first\n  2. second", "Do you want to refactor this?", "Would you like to know", "Enter to select · Esc to cancel", "esc to interrupt", "❯ 1. x"]) {
    const r = claudeScreen(`● OK\n${RULE}\n❯ ${typed}\n${RULE}\n  Haiku 5.5 | scratch@master\n  ⏸ manual mode on\n`);
    expect(r.state).toBe("idle");
    expect(r.input!.replace(/\s+/g, " ")).toBe(typed.replace(/\s+/g, " "));
  }
});

test("Claude's answer never decides the status: dialog words, a numbered list, 'esc to interrupt'", () => {
  for (const ans of ["● Do you want to continue with option 2?", "● Would you like to proceed?", "  ❯ 1. First item", "● Press Enter to confirm your choice", "● Type esc to interrupt anytime", "  1. Red\n  2. Blue\n  Enter to select · Esc to cancel"])
    expect(state(frame(`${ans}\n✻ Baked for 2s · done 1:00 PM`))).toBe("idle");
  // "esc to interrupt" does count in the status lines under the box (wide screens).
  expect(state(`● OK\n${RULE}\n❯ \n${RULE}\n  Haiku 5.5 · esc to interrupt\n`)).toBe("busy");
});

test("only Claude's spinner glyphs make a spinner", () => {
  for (const l of ["→ Loading…", "- Loading…", "● Loading…", "⎿  Loading…"]) expect(state(frame(l))).toBe("idle");
  // "*" is Claude's own on Linux (where macOS shows "✳").
  for (const g of ["·", "✢", "✳", "✶", "✻", "✽", "*"]) expect(state(frame(`${g} Pondering…`))).toBe("busy");
});

test("the prompt box's variants: shell mode, a history search, a recalled prompt, a renamed session; the hints in it aren't text", () => {
  const read = (f: string) => claudeScreen(readFileSync(`${SCREENS}/${f}`, "utf8"));
  expect(read("shell-mode-box.idle.txt")).toMatchObject({ state: "idle", prompt: "shell", input: "" });
  expect(read("history-search.idle.txt")).toMatchObject({ state: "idle", prompt: "search" });
  expect(read("history-search-found-numbered.idle.txt")).toMatchObject({ state: "idle", prompt: "search", input: "1. Reply with just ONE." });
  expect(read("renamed-session-label-rule.idle.txt")).toMatchObject({ state: "idle", prompt: "normal", input: "" });
  expect(read("queued-hint-in-box.busy.txt")).toMatchObject({ state: "busy", prompt: "normal", input: "" });
  expect(read("prompt-with-ellipsis.idle.txt").input).toBe("");
  // ↑ recalls an earlier prompt: the box's top rule says so (as on 2.1.312: "─── History 89/89 ───").
  const recalled = `● ONE\n✻ Baked for 1s · done 10:41 PM\n${"─".repeat(30)} History 2/2 ${"─".repeat(30)}\n❯ 1. Reply with just the word ONE.\n${RULE}\n  Haiku 5.5 | scratch@master\n  ⏸ manual mode on\n`;
  expect(claudeScreen(recalled)).toMatchObject({ state: "idle", prompt: "history", input: "1. Reply with just the word ONE." });
  // The /effort slider is no rule.
  expect(claudeScreen(`${"─".repeat(10)}▲${"─".repeat(20)}`).state).not.toBe("idle");
});

test("a prompt holding a rule and a ❯ line, above an open dialog, is no box", () => {
  const screen = `❯ look at this:\n${RULE}\n❯ fake box\n${RULE}\n● Write(x.txt)\n${RULE}\n Do you want to create x.txt?\n ❯ 1. Yes\n   2. No\n Esc to cancel · Tab to amend`;
  expect(claudeScreen(screen).state).toBe("asking");
});

test("the status line's mode and background shells; nothing from the transcript", () => {
  const rule = "─".repeat(40);
  const screen = (status: string, above = "● ok") => [above, rule, "❯ ", rule, "  Haiku 5.5 | scratch", `  ${status}`].join("\n");
  expect(claudeScreen(screen("⏵⏵ accept edits on (shift+tab to cycle) · ← 2 agents"))).toMatchObject({ state: "idle", mode: "acceptEdits" });
  expect(claudeScreen(screen("⏵⏵ accept edits on (shift+tab to  ·")).mode).toBe("acceptEdits");
  expect(claudeScreen(screen("⏸ plan mode on (shift+tab to cycle)")).mode).toBe("plan");
  expect(claudeScreen(screen("⏵⏵ auto mode on (shift+tab to cycle)")).mode).toBe("auto");
  expect(claudeScreen(screen("⏵⏵ bypass permissions on")).mode).toBe("bypassPermissions");
  expect(claudeScreen(screen("⏸ manual mode on · ← 2 agents")).mode).toBe("default");
  expect(claudeScreen(screen("⏵⏵ don't ask on (shift+tab to cycle) · ← 2 agents")).mode).toBe("dontAsk");
  expect(claudeScreen(screen("? for shortcuts", "⏵⏵ accept edits on")).mode).toBeUndefined();
  expect(claudeScreen(screen("⏸ manual mode on · 1 shell · ← 2 agents")).background).toBe(true);
  expect(claudeScreen(screen("⏸ manual mode on · ← 2 agents")).background).toBeUndefined();
});
