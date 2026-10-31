// The Claude Code adapter (SPEC §6): discovery and history from ~/.claude/projects, live driving
// through the Agent SDK, subagents as child sessions (§6a).

import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { Adapter, Driver, QuitStep, ScreenRead, StartOpts } from "../../core/adapter";
import { CLAUDE_BIN } from "./bin";
import { claudeNeverStarted, claudeProjects, claudeSessionInfo, claudeSessions, claudeStoredMode, claudeSubagents } from "./discovery";
import { ClaudeDriver } from "./driver";
import { readHistory } from "./history";
import { pinStore } from "./jsonl";
import { claudeModels } from "./models";
import { sessionFile, splitNative, storedSubagents } from "./paths";
import { hookSettings } from "../../terminal/hooks";

/**
 * Quitting Claude's TUI whatever it shows: Esc closes a dialog (denying a permission prompt) or stops
 * a turn; Ctrl-C clears what is typed or arms "Press Ctrl-C again to exit"; the next one exits.
 * Steps after it has exited are skipped. For anything but its plain, empty prompt, where `/exit`
 * is cleaner (CLAUDE_EXIT). Verified on 2.1.312 with text in the box and with the /model picker open.
 */
export const CLAUDE_QUIT: QuitStep[] = [{ keys: ["Escape"] }, { waitMs: 400 }, { keys: ["C-c"] }, { waitMs: 400 }, { keys: ["C-c"] }, { waitMs: 400 }, { keys: ["C-c"] }];

/** Quitting Claude's TUI at its empty prompt: /exit (Tether hides it and its goodbye in the transcript). */
export const CLAUDE_EXIT: QuitStep[] = [{ text: "/exit" }, { waitMs: 300 }, { keys: ["Enter"] }];

/**
 * A rule of Claude's prompt box: a line of "─", or one carrying a label ("──── kestrel-test ─" after
 * /rename, "─── History 89/89 ───" while ↑ recalls a prompt). Not the /effort picker's slider
 * ("────▲────": no spaces around its mark).
 */
const RULE = /^\s*─{3,}(?: \S(?:.*\S)? ─+)?\s*$/;
const isRule = (l: string) => RULE.test(l) && (l.match(/─/g)?.length ?? 0) >= 8;
/**
 * A spinner line, in its own form only: one of Claude's spinner glyphs ("*" on Linux where macOS
 * shows "✳"), one word (two for "Compacting conversation…") ending in "…", then at most its "(…"
 * tail, which may wrap. Only used to keep a readopted TUI from passing for idle.
 */
const SPINNER = /^\s*[·✢✳✶✻✽*]\s{1,3}\p{L}[\p{L}'’-]*(?: \p{L}[\p{L}'’-]*)?…(?:\s+\(.*)?\s*$/u;
/** A dialog's own footer (menus and questions alike). */
const DIALOG_FOOTER = /Esc to cancel|Esc to clear|Enter to select|Enter to confirm|Enter to set|to navigate|to adjust|to select ·/;
/** Footers of Claude's own menus (/model, /permissions, /config, /effort), which ask nothing. */
const MENU_FOOTER = /Enter to set|to adjust|Type to filter|←\/→ to switch|Esc to clear|Space to preview/;
/** An option of a numbered list ("  2. No"), and the cursor on one ("❯ 1. Yes"). */
const OPTION = /^\s*(?:❯\s*)?\d+[.)]\s/;
const CURSOR_OPTION = /^\s*❯\s*\d+[.)]\s/;
/** The empty box's hint ('Try "write a test for <filepath>"'), which isn't typed text. */
const PLACEHOLDER = /^(?:Try "[^"]*"|Press up to edit queued messages)$/;

/**
 * Reads Claude's TUI (verified on 2.1.312, at 40 to 200 columns), conservatively, for two things:
 * whether a question is up (Needs you after a runner restart; it clears only once the prompt shows
 * again, SPEC §8), and whether the TUI sits at its plain, empty prompt (Back to Tether quits with
 * /exit there). Only a clearly recognized prompt box counts:
 * - the box is a "❯" (or "!" in shell mode) line right under a rule, closed by a rule, at the
 *   bottom: under it only the status lines (a few, no rule, no choices, no dialog footer, no "❯").
 *   Its `prompt` says how it is: `normal`, `shell` ("!"), `history` (↑ recalled a prompt), `search`
 *   (Ctrl+R), `vim` (NORMAL mode, where typed text is keys). `input` is what is typed in it (the empty box's hint is not). `busy` if a spinner
 *   shows just above it or "esc to interrupt" in the status lines, else `idle`;
 * - no box: `asking` for a numbered choice list under a dialog's rule that isn't one of Claude's
 *   menus, or the trust question; `picker` for Claude's menus; else `unknown`.
 */
/** The permission mode in the TUI's status line, only that glyph-led label ("⏵⏵ accept edits on"). */
const STATUS_MODE = /[⏵⏸]\s*(accept edits|plan mode|auto mode|bypass permissions|manual mode) on/i;
const SHOWN_MODES: Record<string, string> = { "accept edits": "acceptEdits", "plan mode": "plan", "auto mode": "auto", "bypass permissions": "bypassPermissions", "manual mode": "default" };

export function claudeScreen(screen: string): ScreenRead {
  const lines = screen.replace(/\s+$/, "").split("\n");
  let box = -1;
  let close = -1;
  for (let i = lines.length - 1; i > 0 && box < 0; i--) {
    if (!/^\s*[❯!](\s|$)/.test(lines[i]!) || !isRule(lines[i - 1]!)) continue;
    let k = i + 1;
    while (k < Math.min(lines.length, i + 30) && !isRule(lines[k]!)) k++;
    if (k >= lines.length) continue;
    const under = lines.slice(k + 1).filter((l) => l.trim());
    // A "/" typed in the box opens Claude's list of commands under it, the cursor on one.
    const commands = /^\s*❯ \/[\w:-]+/.test(under[0] ?? "") && /^\s*\//.test(lines[i]!.replace(/^\s*[❯!]\s?/, ""));
    if (commands ? under.some((l) => isRule(l) || OPTION.test(l) || DIALOG_FOOTER.test(l)) : under.length > 8 || under.some((l) => isRule(l) || /^\s*❯/.test(l) || OPTION.test(l) || DIALOG_FOOTER.test(l))) continue;
    box = i;
    close = k;
  }
  if (box < 0) {
    const foot = lines.slice(-8);
    const menu = foot.some((l) => MENU_FOOTER.test(l));
    // A question: the cursor on a numbered choice inside a dialog (under its rule), not a menu.
    const cur = lines.findLastIndex((l) => CURSOR_OPTION.test(l));
    if (cur >= 0 && !menu && lines.slice(Math.max(0, cur - 25), cur).some((l) => isRule(l))) return { state: "asking" };
    // The trust question ("❯ No, exit / Yes, I trust this folder").
    if (lines.slice(-14).some((l) => /trust this folder/.test(l)) && foot.some((l) => /Enter to confirm/.test(l))) return { state: "asking" };
    if (menu || cur >= 0 || foot.some((l) => DIALOG_FOOTER.test(l))) return { state: "picker" };
    return { state: "unknown" };
  }
  const above = lines.slice(0, box - 1);
  const status = lines.slice(close + 1);
  const top = lines[box - 1]!;
  const prompt = /^\s*!/.test(lines[box]!) ? "shell" : /─ History \d+\/\d+ ─/.test(top) ? "history" : status.some((l) => /search prompts:/.test(l)) ? "search" : status.some((l) => /-- NORMAL --/.test(l)) ? "vim" : "normal";
  // What is typed in the box: its lines up to the closing rule, without the "❯ " and indentation.
  let typed = lines
    .slice(box, close)
    .map((l, n) => l.replace(n === 0 ? /^\s*[❯!]\s?/ : /^\s+/, ""))
    .join("\n")
    .trim();
  if (PLACEHOLDER.test(typed)) typed = "";
  const near = above.slice(-15);
  const busy = near.some((l) => SPINNER.test(l)) || status.some((l) => /esc to interrupt/i.test(l));
  const line = status.join("\n");
  const label = line.match(STATUS_MODE)?.[1]?.toLowerCase();
  return { state: busy ? "busy" : "idle", input: typed, prompt, ...(label ? { mode: SHOWN_MODES[label] } : {}), ...(/\b\d+ shells?\b/.test(line) ? { background: true } : {}) };
}


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
  storeChangedAt(nativeId, projectPath) {
    const f = sessionFile(splitNative(nativeId).session, projectPath);
    try {
      return f ? statSync(f).mtimeMs : undefined;
    } catch {
      return undefined;
    }
  },
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

  neverStarted: claudeNeverStarted,
  storedMode: claudeStoredMode,
  newId: () => randomUUID(),
  ownModel: (model) => model.startsWith("claude"),
  terminalSettingsHint: "/model, and Shift+Tab for the mode",

  // Terminal mode (SPEC §8): Claude's own TUI, handed the session. `--settings` adds Tether's hooks
  // for this launch only, so "needs you" and the mode as last seen reach the runner (terminal/hooks.ts).
  terminalCommand(nativeId, _projectPath, opts) {
    const argv = [CLAUDE_BIN ?? "claude", ...(opts.fresh ? ["--session-id", nativeId] : ["--resume", nativeId])];
    if (opts.model && opts.model !== "default") argv.push("--model", opts.model);
    if (opts.effort) argv.push("--effort", opts.effort);
    if (opts.permissionMode) argv.push("--permission-mode", opts.permissionMode);
    if (opts.report) argv.push("--settings", hookSettings(opts.report.socketPath, opts.report.sessionId, undefined, opts.report.tui));
    return { argv, quit: CLAUDE_QUIT, quitAtPrompt: CLAUDE_EXIT, screen: claudeScreen };
  },
};
