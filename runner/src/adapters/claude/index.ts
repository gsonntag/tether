// The Claude Code adapter (SPEC §6): discovery and history from ~/.claude/projects, live driving
// through the Agent SDK, subagents as child sessions (§6a).

import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { Adapter, Driver, QuitStep, StartOpts } from "../../core/adapter";
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
  capabilities: { canSteer: true, terminal: "handoff", subagents: { view: true, stop: true, steer: false } },

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

  // Terminal mode (SPEC §8): Claude's own TUI, handed the session. `--settings` adds Tether's hooks
  // for this launch only, so turn ends and "needs you" reach the runner (terminal/hooks.ts).
  terminalCommand(nativeId, _projectPath, opts) {
    const argv = [CLAUDE_BIN ?? "claude", ...(opts.fresh ? ["--session-id", nativeId] : ["--resume", nativeId])];
    if (opts.model && opts.model !== "default") argv.push("--model", opts.model);
    if (opts.effort) argv.push("--effort", opts.effort);
    if (opts.permissionMode) argv.push("--permission-mode", opts.permissionMode);
    if (opts.report) argv.push("--settings", hookSettings(opts.report.socketPath, opts.report.sessionId));
    return { argv, quit: CLAUDE_QUIT };
  },
};
