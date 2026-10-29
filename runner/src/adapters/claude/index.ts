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

/** A horizontal rule of Claude's prompt box. */
const RULE = /^\s*[─━]{8,}/;
/** The prompt box's input line ("❯ " and whatever is typed), not a selection ("❯ 1. Yes"). */
const INPUT = /^\s*❯(?!\s*\d+\.)(\s|$)/;
/**
 * A spinner line: one glyph, then a word or more ending in "…", with or without the "(16s · ↓ 213
 * tokens)" tail: "✻ Brewing…", "· Determining… (running PreToolUse hook · 16s)", "✻ Compacting
 * conversation…", and a tool still running ("⎿  Waiting…"). The done line ("✻ Churned for 49s") has
 * no "…".
 */
const SPINNER = /^\s*[^\s\w"'`(\[]\s+\S[^\n]*…/;
/** A selection list (permission prompts, plan approval, pickers) and dialogs' own footers. */
const ASKING = /^\s*❯\s*\d+\.\s|Esc to cancel|Enter to confirm|Enter to select|Enter to set|Would you like to|Do you want to/m;

/**
 * Reads Claude's TUI (verified on 2.1.312, at 53 to 120 columns). Idle only on a positive sign: the
 * prompt box at the bottom (a dialog replaces it) with no spinner line above it and nothing saying
 * it works ("esc to interrupt" only shows on wide screens). Anything not recognized is `unknown`,
 * never idle.
 */
export function claudeScreen(screen: string): ScreenRead {
  const lines = screen.replace(/\s+$/, "").split("\n");
  // The prompt box: a rule, the input line(s), a rule; the last one on screen.
  let box = -1;
  for (let i = lines.length - 1; i > 0 && box < 0; i--) {
    if (!INPUT.test(lines[i]!) || !RULE.test(lines[i - 1]!)) continue;
    for (let k = i + 1; k < Math.min(lines.length, i + 20); k++) if (RULE.test(lines[k]!)) {
      box = i;
      break;
    }
  }
  if (box < 0) return { state: ASKING.test(screen) ? "asking" : "unknown", body: screen };
  const above = lines.slice(0, box - 1);
  const body = above.join("\n");
  // Just above the box: the spinner, the todo list under it, tips.
  const near = above.slice(-15);
  if (/esc to interrupt/i.test(screen) || near.some((l) => SPINNER.test(l))) return { state: "busy", body };
  return { state: "idle", body };
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
    return { argv, quit: CLAUDE_QUIT, submit: CLAUDE_SUBMIT, screen: claudeScreen };
  },
};
