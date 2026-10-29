// The Claude Code adapter (SPEC §6): discovery and history from ~/.claude/projects, live driving
// through the Agent SDK, subagents as child sessions (§6a).

import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { Adapter, Driver, QuitStep, ScreenRead, StartOpts } from "../../core/adapter";
import { CLAUDE_BIN } from "./bin";
import { claudeProjects, claudeSessionInfo, claudeSessions, claudeSubagents } from "./discovery";
import { ClaudeDriver } from "./driver";
import { readHistory } from "./history";
import { pinStore } from "./jsonl";
import { claudeModels } from "./models";
import { sessionFile, splitNative, storedSubagents } from "./paths";
import { hookSettings } from "../../terminal/hooks";

/**
 * Quitting Claude's TUI whatever it shows: Esc closes a dialog (denying a permission prompt) or stops
 * a turn; Ctrl-C clears what is typed or arms "Press Ctrl-C again to exit"; the next one exits.
 * Steps after it has exited are skipped. Unlike `/exit`, nothing lands in the transcript (verified
 * on 2.1.312 with text in the box and with the /model picker open).
 */
export const CLAUDE_QUIT: QuitStep[] = [{ keys: ["Escape"] }, { waitMs: 400 }, { keys: ["C-c"] }, { waitMs: 400 }, { keys: ["C-c"] }, { waitMs: 400 }, { keys: ["C-c"] }];

/**
 * Submitting typed text: Claude's TUI sometimes takes an Enter right after typed text as a newline
 * (seen in a TUI that had just started, every Enter after that too), and any other key first
 * clears that. End is harmless: the cursor is at the end already.
 */
export const CLAUDE_SUBMIT: QuitStep[] = [{ waitMs: 150 }, { keys: ["End"] }, { waitMs: 100 }, { keys: ["Enter"] }];

/** A horizontal rule of Claude's prompt box: nothing but the line (not the /effort picker's slider). */
const RULE = /^\s*[─━]{8,}\s*$/;
/**
 * A spinner line, in its own form only: one of Claude's spinner glyphs, one word (two for
 * "Compacting conversation…") ending in "…", then at most its "(…" tail, which may wrap: "✻
 * Brewing…", "· Determining… (running PreToolUse hook · 16s · ↓ 213 tokens)", "✢ Lollygagging… (1m
 * 4s · esc to interrupt)", "✻ Compacting conversation…". Not text that happens to hold a "…" ("-
 * Let me think…", "→ Loading…", a prompt echoed with "❯"), and not the done line ("✻ Churned for
 * 49s").
 */
const SPINNER = /^\s*[·✢✳✶✻✽]\s{1,3}\p{L}[\p{L}'’-]*(?: \p{L}[\p{L}'’-]*)?…(?:\s+\(.*)?\s*$/u;
/** A dialog's own footer (pickers and questions alike). */
const DIALOG_FOOTER = /Esc to cancel|Esc to clear|Enter to select|Enter to confirm|Enter to set|to navigate|to adjust|to select ·/;
/** An option of a numbered list ("  2. No"), and the cursor on one ("❯ 1. Yes"). */
const OPTION = /^\s*(?:❯\s*)?\d+[.)]\s/;
const CURSOR_OPTION = /^\s*❯\s*\d+[.)]\s/;
/** What a question says right above its choices. */
const QUESTION = /\?\s*$|Do you want to|Would you like to|trust this folder/;

/**
 * Reads Claude's TUI (verified on 2.1.312, at 45 to 120 columns), by its structure only, so that
 * text in Claude's answer or in the person's prompt never decides the status:
 * - the prompt box is a "❯" line right under a rule, closed by a rule below, with nothing of a
 *   dialog under it (no choices, no dialog footer): then `busy` if a spinner shows just above it (or
 *   "esc to interrupt" in the status lines under it), else `idle`; whatever is in the box (even
 *   "1. Reply…", "Do you want to…") is only what is typed;
 * - no prompt box: `asking` for a question (a list with the cursor on a choice and a question right
 *   above it: permission prompts, plan approval, AskUserQuestion; the trust question), `picker` for
 *   Claude's own menus (/model, /resume, /permissions, /config, /effort: a dialog footer, no
 *   question), else `unknown`.
 */
export function claudeScreen(screen: string): ScreenRead {
  const lines = screen.replace(/\s+$/, "").split("\n");
  // The prompt box: the last "❯" line right under a rule, closed by a rule, no dialog under it.
  let box = -1;
  let close = -1;
  for (let i = lines.length - 1; i > 0 && box < 0; i--) {
    if (!/^\s*❯/.test(lines[i]!) || !RULE.test(lines[i - 1]!)) continue;
    let k = i + 1;
    while (k < Math.min(lines.length, i + 30) && !RULE.test(lines[k]!)) k++;
    if (k >= lines.length || !RULE.test(lines[k]!)) continue;
    const under = lines.slice(k + 1);
    if (under.some((l) => OPTION.test(l) || DIALOG_FOOTER.test(l))) continue;
    box = i;
    close = k;
  }
  if (box < 0) {
    // A question: the cursor on a numbered choice, and a question in the dialog above the choices
    // (from the rule that starts the dialog; options and their wrapped lines aside).
    const cur = lines.findLastIndex((l) => CURSOR_OPTION.test(l));
    if (cur >= 0) {
      let top = cur;
      while (top > 0 && cur - top < 25 && !RULE.test(lines[top - 1]!)) top--;
      if (lines.slice(top, cur).some((l) => !OPTION.test(l) && QUESTION.test(l))) return { state: "asking", body: screen };
    }
    // The trust question ("❯ No, exit / Yes, I trust this folder").
    const foot = lines.slice(-8);
    if (lines.slice(-14).some((l) => /trust this folder/.test(l)) && foot.some((l) => /Enter to confirm/.test(l))) return { state: "asking", body: screen };
    if (foot.some((l) => DIALOG_FOOTER.test(l)) || cur >= 0) return { state: "picker", body: screen };
    return { state: "unknown", body: screen };
  }
  const above = lines.slice(0, box - 1);
  const body = above.join("\n");
  // What is typed in the box: its lines up to the closing rule, without the "❯ " and indentation.
  const typed = lines
    .slice(box, close)
    .map((l, n) => l.replace(n === 0 ? /^\s*❯\s?/ : /^\s+/, ""))
    .join("\n")
    .trimEnd();
  // Just above the box: the spinner, the todo list under it, tips. Under it: the status lines.
  const near = above.slice(-15);
  const status = lines.slice(close + 1);
  if (near.some((l) => SPINNER.test(l)) || status.some((l) => /esc to interrupt/i.test(l))) return { state: "busy", body, input: typed };
  return { state: "idle", body, input: typed };
}

/** Whether the screen shows Claude idle at its prompt (see claudeScreen). */
export const claudeScreenIdle = (screen: string) => claudeScreen(screen).state === "idle";

/** How often a watched stored session's file is checked for changes. */
const WATCH_MS = 1000;

function watchFile(path: () => string | undefined, onChange: () => void): () => void {
  let last: string | undefined;
  let stopped = false;
  let busy = false;
  const check = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const p = path();
      const s = p ? await stat(p).catch(() => undefined) : undefined;
      const stamp = s ? `${s.size}:${s.mtimeMs}` : "";
      if (last !== undefined && stamp !== last) onChange();
      last = stamp;
    } finally {
      busy = false;
    }
  };
  void check();
  const t = setInterval(check, WATCH_MS);
  t.unref?.();
  return () => {
    stopped = true;
    clearInterval(t);
  };
}

export const claudeAdapter: Adapter = {
  id: "claude",
  capabilities: { canSteer: true, terminal: "handoff", subagents: { view: true, stop: true, steer: "via-parent" } },

  async available() {
    return !!CLAUDE_BIN;
  },

  listProjects: claudeProjects,
  listSessions: claudeSessions,
  sessionInfo: claudeSessionInfo,
  async listSubagents(nativeId, projectPath) {
    return claudeSubagents(splitNative(nativeId).session, projectPath);
  },
  readHistory,

  watchHistory(nativeId, projectPath, onChange) {
    const { session, agent } = splitNative(nativeId);
    const file = () => (agent ? storedSubagents(session, projectPath).find((c) => c.agentId === agent)?.file : sessionFile(session, projectPath));
    // A main session's file stays parsed while watched (jsonl.ts): changes parse only what was appended.
    let pinnedPath: string | undefined;
    let unpin = () => {};
    const pin = () => {
      const p = agent ? undefined : file();
      if (p && p !== pinnedPath) {
        unpin();
        pinnedPath = p;
        unpin = pinStore(p);
      }
    };
    pin();
    let reading = false;
    let again = false;
    const reread = async () => {
      if (reading) return void (again = true);
      reading = true;
      try {
        do {
          again = false;
          pin();
          onChange(await readHistory(nativeId, projectPath));
        } while (again);
      } catch {
        // A half-written file: the next change reads it again.
      } finally {
        reading = false;
      }
    };
    const stop = watchFile(file, () => void reread());
    return () => {
      stop();
      unpin();
    };
  },

  async defaults(projectPath): Promise<StartOpts> {
    const r: any = await resolveSettings({ cwd: projectPath, settingSources: ["user", "project", "local"] }).catch(() => undefined);
    const eff = r?.effective ?? {};
    return {
      ...(typeof eff.model === "string" ? { model: eff.model } : {}),
      ...(typeof eff.effortLevel === "string" ? { effort: eff.effortLevel } : {}),
      ...(typeof eff.permissions?.defaultMode === "string" ? { permissionMode: eff.permissions.defaultMode } : {}),
    };
  },

  start: (projectPath, nativeId, opts, sink) => ClaudeDriver.open(nativeId, projectPath, opts, sink, false),
  resume: (nativeId, projectPath, opts, sink) => ClaudeDriver.open(nativeId, projectPath, opts, sink, true),

  listModels(driver?: Driver) {
    return claudeModels(driver instanceof ClaudeDriver ? () => driver.models() : undefined);
  },

  newId: () => randomUUID(),
  ownModel: (model) => model.startsWith("claude"),
  terminalSettingsHint: "/model, and Shift+Tab for the mode",

  // Terminal mode (SPEC §8): Claude's own TUI, handed the session. `--settings` adds Tether's hooks
  // for this launch only, so turn ends and "needs you" reach the runner (terminal/hooks.ts).
  terminalCommand(nativeId, _projectPath, opts) {
    const argv = [CLAUDE_BIN ?? "claude", ...(opts.fresh ? ["--session-id", nativeId] : ["--resume", nativeId])];
    if (opts.model && opts.model !== "default") argv.push("--model", opts.model);
    if (opts.effort) argv.push("--effort", opts.effort);
    if (opts.permissionMode) argv.push("--permission-mode", opts.permissionMode);
    if (opts.report) argv.push("--settings", hookSettings(opts.report.socketPath, opts.report.sessionId, undefined, opts.report.tui));
    return { argv, quit: CLAUDE_QUIT, submit: CLAUDE_SUBMIT, screen: claudeScreen, paste: true };
  },
};
