// The Antigravity adapter (SPEC §6): Google's coding agent through its CLI, `agy`. Live sessions
// speak the Agent Client Protocol to `agy acp` (driver.ts); discovery and history ask a shared
// `agy acp` too (store.ts); the Terminal button hands the session to `agy --conversation <id>`.

import { basename } from "node:path";
import type { ProjectInfo, SessionSummary } from "../../../../shared/transcript";
import type { Adapter, StartOpts } from "../../core/adapter";
import { HARNESS_BINS } from "../detect";
import { AgyDriver } from "./driver";
import { billingOf, modelList } from "./models";
import { AGY_EXIT, AGY_QUIT, agyScreen } from "./screen";
import { hasStore, lastCommands, reader, seenContext, seenSettings, seenTitles, storeStamp, type AgySession } from "./store";

const summary = (s: AgySession): SessionSummary => ({
  id: `antigravity:${s.sessionId}`,
  harness: "antigravity",
  nativeId: s.sessionId,
  projectPath: s.cwd,
  title: seenTitles.get(s.sessionId) ?? s.title,
  mode: "stored",
  status: "idle",
  updatedAt: s.updatedAt,
});

/** How often a watched session's store is checked for changes. */
const WATCH_MS = 1000;

export const antigravityAdapter: Adapter = {
  id: "antigravity",
  capabilities: { canSteer: false, terminal: "handoff", subagents: { view: false, stop: false, steer: false }, commands: true },

  async available() {
    return !!Bun.which(HARNESS_BINS.antigravity);
  },

  async listProjects(): Promise<ProjectInfo[]> {
    const byPath = new Map<string, ProjectInfo>();
    for (const s of await reader.list()) {
      const p = byPath.get(s.cwd) ?? { path: s.cwd, name: basename(s.cwd) || s.cwd, harnesses: ["antigravity"], updatedAt: 0, sessions: 0 };
      p.sessions++;
      p.updatedAt = Math.max(p.updatedAt, s.updatedAt);
      byPath.set(s.cwd, p);
    }
    return [...byPath.values()];
  },

  async listSessions(opts) {
    return (await reader.list()).filter((s) => (!opts?.projectPath || s.cwd === opts.projectPath) && (!opts?.since || s.updatedAt >= opts.since)).map(summary);
  },

  async sessionInfo(nativeId) {
    let s = (await reader.list()).find((x) => x.sessionId === nativeId);
    // Listed since the cached listing (its first prompt): ask again.
    if (!s && hasStore(nativeId)) {
      reader.forget();
      s = (await reader.list()).find((x) => x.sessionId === nativeId);
    }
    return s ? summary(s) : undefined;
  },

  storeChangedAt: (nativeId) => storeStamp(nativeId)?.at,
  storeRevision: (nativeId) => storeStamp(nativeId)?.rev,
  noStore: async (nativeId) => !hasStore(nativeId),

  async listSubagents() {
    return [];
  },

  async readHistory(nativeId, projectPath) {
    return (await reader.replay(nativeId, projectPath)).msgs;
  },

  async storedContext(nativeId) {
    return seenContext.get(nativeId);
  },
  storedBilling: async () => billingOf(),

  watchHistory(nativeId, projectPath, onChange) {
    let last = storeStamp(nativeId)?.rev ?? "";
    let stopped = false;
    let reading = false;
    let again = false;
    const reread = async () => {
      if (reading) return void (again = true);
      reading = true;
      try {
        do {
          again = false;
          const { msgs } = await reader.replay(nativeId, projectPath);
          if (!stopped) onChange(msgs);
        } while (again && !stopped);
      } catch {
        // Mid-write: the next change reads it again.
      } finally {
        reading = false;
      }
    };
    const t = setInterval(() => {
      const rev = storeStamp(nativeId)?.rev ?? "";
      if (rev === last) return;
      last = rev;
      void reread();
    }, WATCH_MS);
    t.unref?.();
    return () => {
      stopped = true;
      clearInterval(t);
    };
  },

  /** A session's settings as Antigravity last showed them (a load, a live process); none yet: its own defaults. */
  async defaults(_projectPath, nativeId): Promise<StartOpts> {
    return { ...(nativeId ? seenSettings.get(nativeId) : undefined) };
  },

  start: (projectPath, nativeId, opts, sink) => AgyDriver.open(nativeId, projectPath, opts, sink),
  resume: (nativeId, projectPath, opts, sink) => AgyDriver.open(nativeId, projectPath, opts, sink),

  async listModels() {
    return modelList(await reader.config().catch(() => []));
  },

  async listCommands(_projectPath, driver) {
    const list = driver instanceof AgyDriver ? driver.commands() : (lastCommands ?? []);
    return list.map((c) => ({ name: c.name, description: c.description ?? "" }));
  },

  /** Antigravity picks session ids: the conversation is made now, and its driver loads it. */
  newId: (projectPath) => reader.create(projectPath),

  terminalSettingsHint: "/model, and Shift+Tab for the mode",

  // Terminal (SPEC §8, handoff): Antigravity's own TUI on the same conversation, in the session's
  // mode. Its model and thinking level are the TUI's own: on a resumed conversation it ignores
  // --model and --effort (checked on 1.5.13).
  terminalCommand(nativeId, _projectPath, opts) {
    const argv = [HARNESS_BINS.antigravity, "--conversation", nativeId];
    if (opts.permissionMode === "accept-edits" || opts.permissionMode === "plan") argv.push("--mode", opts.permissionMode);
    return { argv, quit: AGY_QUIT, quitAtPrompt: AGY_EXIT, screen: agyScreen };
  },
};
