// The Codex adapter (SPEC §6): discovery and history from the daemon's thread store, live driving
// through the shared app-server daemon, subagents as child threads (§6a), and a shared terminal:
// Codex's own TUI joins the live thread beside Tether (§8).

import { HARNESS_KEYS } from "../../../../shared/credentials";
import type { Msg } from "../../../../shared/transcript";
import type { Adapter, QuitStep, StartOpts } from "../../core/adapter";
import { HARNESS_BINS } from "../detect";
import { call } from "./daemon";
import { DAEMON_SOCKET } from "./rpc";
import { codexBackgroundRuns, codexHistory, codexNoStore, codexPlan, codexProjects, codexSessionInfo, codexSessions, codexStoredBilling, codexStoredContext, codexSubagents, threadSettings, watchThread } from "./discovery";
import { codexCommandRoute, commandList, enabledSkills } from "./commands";
import { CodexDriver, codexTools, createThread } from "./driver";
import { setCodexSetup } from "./setup";
import { codexMove, importedMsgs } from "./move";
import { knownMode, modeOf, modelList, UNKNOWN_MODE, type CodexModel } from "./modes";
import { remembered } from "./remember";
import { assertThreadSource, sourceBilling, sourceHome, sourceProvider, sourceSocket } from "./sources";

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

/** The stored turns, after what a move imported (not turns, so the daemon doesn't list it). */
const fullHistory = async (nativeId: string, projectPath: string): Promise<Msg[]> => {
  // A thread that took a session's place shows that session's own transcript, not its import.
  const before = remembered(nativeId)?.carriedFrom;
  return [...(before ? await fullHistory(before, projectPath) : await importedMsgs(nativeId)), ...(await codexHistory(nativeId, projectPath))];
};

export const codexAdapter: Adapter = {
  id: "codex",
  agentSetup: setCodexSetup,
  capabilities: { canSteer: true, terminal: "shared", subagents: { view: true, stop: true, steer: "via-parent" }, persistent: true, settingsApply: "nextTurn", sourceSwitch: true, sourceCarry: true, commands: true, move: { import: "native" } },
  move: codexMove,
  toolServer: (server) => codexTools.set(server),
  billing: {
    keys: HARNESS_KEYS.codex,
    label: (source) => (source === "openai" || source === "azure" ? sourceBilling(source) : { kind: "plan", label: "ChatGPT plan" }),
    // Asked of the shared daemon, whose login a subscription session uses.
    loggedIn: async () => (await call("account/read", { refreshToken: false }, 10_000))?.account?.type === "chatgpt",
    // A private thread lives with its source. Any other is on the shared daemon: its login.
    recorded: (nativeId) => remembered(nativeId)?.source?.source ?? "subscription",
  },

  async available() {
    return !!Bun.which(HARNESS_BINS.codex);
  },

  listProjects: codexProjects,
  listSessions: (opts) => codexSessions(opts),
  sessionInfo: (nativeId) => codexSessionInfo(nativeId),
  listSubagents: (nativeId) => codexSubagents(nativeId),
  backgroundRuns: codexBackgroundRuns,
  readHistory: fullHistory,
  storedContext: (nativeId) => codexStoredContext(nativeId),
  planUsage: codexPlan,
  storedBilling: (nativeId) => codexStoredBilling(nativeId),
  watchHistory: (nativeId, projectPath, onChange) => watchThread(nativeId, projectPath, onChange, fullHistory),

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

  async listCommands(projectPath, driver) {
    if (driver instanceof CodexDriver) return driver.commands();
    return commandList(enabledSkills(await call("skills/list", { cwds: [projectPath] })));
  },
  commandRoute: codexCommandRoute,

  async listModels() {
    return modelList(await fetchModels().catch(() => []));
  },

  /** Codex picks thread ids: the thread is made now, in the daemon, and its driver takes it. */
  newId: (projectPath, opts) => createThread(projectPath, opts),

  /** A thread with no rollout can't be joined again (thread/resume: "no rollout found"): a new one takes over. */
  async renew(projectPath, { permissionMode, ...rest }) {
    const opts = { ...rest, ...(knownMode(permissionMode) ? { permissionMode } : {}) };
    return { nativeId: await createThread(projectPath, opts), opts };
  },
  noStore: codexNoStore,

  // Terminal (SPEC §8, shared): Codex's TUI joins the same thread through the daemon (`--remote`;
  // without it the TUI runs its own app-server and finds the thread "open in another app"), beside
  // Tether's connection. Approvals stay routed to clients, so Tether and the TUI both ask; the
  // permissions are the thread's: remote resume rejects CLI permission overrides. No update
  // prompt: it would block the TUI.
  terminalCommand(nativeId, _projectPath, opts) {
    const source = remembered(nativeId)?.source;
    assertThreadSource(source, opts.credential);
    const remote = source ? `unix://${sourceSocket(source)}` : process.env.CODEX_DAEMON_SOCKET || process.env.CODEX_HOME ? `unix://${DAEMON_SOCKET}` : "unix://";
    const argv = [HARNESS_BINS.codex, "resume", "--remote", remote, nativeId, "-c", "check_for_update_on_startup=false"];
    argv.push("-c", `model_provider=${toml(source ? sourceProvider(source.source) : "openai")}`);
    const model = opts.model && opts.model !== "default" ? opts.model : opts.credential?.source === "azure" ? opts.credential.deployment : undefined;
    if (model && model !== "default") argv.push("-m", model);
    if (opts.effort) argv.push("-c", `model_reasoning_effort=${toml(opts.effort)}`);
    // tmux may have inherited provider keys long before this runner started.
    const remove = new Set(["OPENAI_API_KEY", "CODEX_API_KEY", "AZURE_OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "TETHER_GATEWAY_KEY"]);
    for (const name of Object.keys(process.env)) if (/^(OPENAI_|AZURE_|ANTHROPIC_|TETHER_GATEWAY_)/.test(name)) remove.add(name);
    if (!source) remove.add("TETHER_CODEX_API_KEY");
    const command = opts.credential ? ["env", ...[...remove].flatMap((name) => ["-u", name]), ...argv] : argv;
    return { argv: command, ...(source ? { env: { CODEX_HOME: sourceHome(source), TETHER_CODEX_API_KEY: `tether-private-${source.id}` } } : {}), quit: CODEX_QUIT };
  },
};
