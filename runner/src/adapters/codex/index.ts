// The Codex adapter (SPEC §6): discovery and history from the daemon's thread store, live driving
// through the shared app-server daemon, subagents as child threads (§6a), and a shared terminal:
// Codex's own TUI joins the live thread beside Tether (§8).

import type { Adapter, QuitStep, StartOpts } from "../../core/adapter";
import { HARNESS_BINS } from "../detect";
import { call } from "./daemon";
import { DAEMON_SOCKET } from "./rpc";
import { codexBackgroundRuns, codexHistory, codexProjects, codexSessionInfo, codexSessions, codexSubagents, threadSettings, watchThread } from "./discovery";
import { CodexDriver, createThread } from "./driver";
import { knownMode, modeOf, modelList, UNKNOWN_MODE, type CodexModel } from "./modes";
import { remembered } from "./remember";

/**
 * Quitting Codex's TUI without stopping the thread's turn: Ctrl-C clears what's typed (or, with an
 * empty box, asks to press it again), the second quits. The TUI is a client of the daemon, so the
 * turn goes on.
 */
export const CODEX_QUIT: QuitStep[] = [{ keys: ["C-c"] }, { waitMs: 300 }, { keys: ["C-c"] }, { waitMs: 300 }, { keys: ["C-c"] }];

let models: { at: number; list: CodexModel[] } | undefined;
const MODELS_MS = 10 * 60_000;

async function fetchModels(): Promise<CodexModel[]> {
  if (models && Date.now() - models.at < MODELS_MS) return models.list;
  const list: CodexModel[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 10; i++) {
    const r: any = await call("model/list", { cursor });
    list.push(...(r?.data ?? []));
    if (!(cursor = r?.nextCursor)) break;
  }
  models = { at: Date.now(), list };
  return list;
}

const toml = (v: string) => JSON.stringify(v);
/** Approval policies `codex -a` takes. */
const CLI_POLICIES = new Set(["on-request", "never"]);

export const codexAdapter: Adapter = {
  id: "codex",
  capabilities: { canSteer: true, terminal: "shared", subagents: { view: true, stop: true, steer: "via-parent" }, persistent: true, settingsApply: "nextTurn" },

  async available() {
    return !!Bun.which(HARNESS_BINS.codex);
  },

  listProjects: codexProjects,
  listSessions: (opts) => codexSessions(opts),
  sessionInfo: (nativeId) => codexSessionInfo(nativeId),
  listSubagents: (nativeId) => codexSubagents(nativeId),
  backgroundRuns: codexBackgroundRuns,
  readHistory: codexHistory,
  watchHistory: watchThread,

  /**
   * A thread's own settings (what it last ran with); for a folder, Codex's config. Shown before the
   * session starts, and never sent back to the thread: it keeps its own (driver.ts).
   */
  async defaults(projectPath, nativeId): Promise<StartOpts> {
    if (nativeId) {
      // An existing thread: its own settings, else what Tether last saw of them, else unknown. Never
      // Codex's config (not what the thread has), which would also become the TUI's launch flags.
      const own = await threadSettings(nativeId).catch(() => null);
      // Default picked in Tether, and still running the default model: shown as Default.
      if (own?.model && remembered(nativeId)?.modelAlias === "default") {
        const def = (await fetchModels().catch(() => [] as CodexModel[])).find((m) => m.isDefault)?.id;
        if (def === own.model) return { ...own, model: "default" };
      }
      if (own) return own;
      const r = remembered(nativeId);
      const { at: _, ...seen } = (r?.applied ?? r?.start ?? {}) as StartOpts & { at?: number };
      if (own === null || r) return { ...seen, permissionMode: seen.permissionMode ?? UNKNOWN_MODE };
    }
    const r: any = await call("config/read", { cwd: projectPath }).catch(() => undefined);
    const c = r?.config ?? {};
    const mode = modeOf(c.approval_policy ?? "on-request", c.sandbox_mode ?? "workspace-write");
    return {
      ...(typeof c.model === "string" ? { model: c.model } : {}),
      ...(typeof c.model_reasoning_effort === "string" ? { effort: c.model_reasoning_effort } : {}),
      ...(mode ? { permissionMode: mode } : {}),
    };
  },

  start: (projectPath, nativeId, opts, sink) => CodexDriver.open(nativeId, projectPath, opts, sink, false),
  resume: (nativeId, projectPath, opts, sink) => CodexDriver.open(nativeId, projectPath, opts, sink, true),

  async listModels() {
    return modelList(await fetchModels().catch(() => []));
  },

  /** Codex picks thread ids: the thread is made now, in the daemon, and its driver takes it. */
  newId: (projectPath, opts) => createThread(projectPath, opts),

  // Terminal (SPEC §8, shared): Codex's TUI joins the same thread through the daemon (`--remote`;
  // without it the TUI runs its own app-server and finds the thread "open in another app"), beside
  // Tether's connection. Approvals stay routed to clients, so Tether and the TUI both ask; the
  // model, effort and permissions are the session's (the CLI takes only some approval policies:
  // with "untrusted" the thread keeps its own). No update prompt: it would block the TUI.
  terminalCommand(nativeId, _projectPath, opts) {
    const remote = process.env.CODEX_DAEMON_SOCKET || process.env.CODEX_HOME ? `unix://${DAEMON_SOCKET}` : "unix://";
    const argv = [HARNESS_BINS.codex, "resume", "--remote", remote, nativeId, "-c", "check_for_update_on_startup=false", "-c", `approvals_reviewer=${toml("user")}`];
    if (opts.model && opts.model !== "default") argv.push("-m", opts.model);
    if (opts.effort) argv.push("-c", `model_reasoning_effort=${toml(opts.effort)}`);
    const m = knownMode(opts.permissionMode);
    if (m && CLI_POLICIES.has(m.approvalPolicy)) argv.push("-a", m.approvalPolicy, "-s", m.sandbox);
    return { argv, quit: CODEX_QUIT };
  },
};
