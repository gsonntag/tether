// The Antigravity adapter (SPEC §6): Google's coding agent through its CLI, `agy`. Live sessions
// speak the Agent Client Protocol to `agy acp` (driver.ts); discovery and history ask a shared
// `agy acp` too (store.ts); the Terminal button hands the session to `agy --conversation <id>`.
// Subagents are conversations of their own (subagents.ts); a fork is a copy of the store (fork.ts);
// a move comes in by Tether's context route (SPEC §15), as ACP has no import.

import { basename } from "node:path";
import { LEVELS } from "../../../../shared/move";
import type { Msg, ProjectInfo, SessionSummary, ToolPart } from "../../../../shared/transcript";
import type { Adapter, StartOpts } from "../../core/adapter";
import { HARNESS_BINS } from "../detect";
import { agyTools, AgyDriver } from "./driver";
import { agyFork } from "./fork";
import { billingOf, BYPASS, modelList } from "./models";
import { AGY_EXIT, AGY_QUIT, agyScreen } from "./screen";
import { hasStore, lastCommands, reader, seenContext, seenSettings, seenTitles, stampOf, storeStamp, type AgySession } from "./store";
import { childInfo, childrenOf, matchCalls } from "./subagents";

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

/** What a subagent's parent said of it: the call that started it, found in the parent's transcript. */
interface ChildMeta {
  parent: string;
  toolId?: string;
  role?: string;
  type?: string;
  prompt: string;
}
const childMeta = new Map<string, ChildMeta>();

/** The `invoke_subagent` calls in a transcript. */
function subagentCalls(msgs: Msg[]) {
  return msgs.flatMap((m) => m.parts.filter((p): p is ToolPart => p.type === "tool" && p.name === "invoke_subagent")).map((p) => {
    const raw = ((p.input as any)?.raw ?? {}) as Record<string, unknown>;
    return { toolId: p.id, prompt: typeof raw.Prompt === "string" ? raw.Prompt : "", ...(typeof raw.Role === "string" ? { role: raw.Role } : {}), ...(typeof raw.TypeName === "string" ? { type: raw.TypeName } : {}) };
  });
}

/** A parent's subagents, each with the call that started it (from the parent's replay). */
async function subagentsOf(parent: string, projectPath: string): Promise<SessionSummary[]> {
  const children = childrenOf(parent);
  if (!children.length) return [];
  const calls = subagentCalls((await reader.replay(parent, projectPath)).msgs);
  const matched = matchCalls(children, calls);
  return children.map((c) => {
    const call = matched.get(c.nativeId);
    const meta: ChildMeta = { parent, prompt: call?.prompt || c.prompt, ...(call ? { toolId: call.toolId } : {}), ...(call?.role ? { role: call.role } : {}), ...(call?.type ? { type: call.type } : {}) };
    childMeta.set(c.nativeId, meta);
    return childSummary(c.nativeId, projectPath, meta);
  });
}

function childSummary(nativeId: string, projectPath: string, meta: ChildMeta): SessionSummary {
  return {
    id: `antigravity:${nativeId}`,
    harness: "antigravity",
    nativeId,
    projectPath,
    title: meta.role || meta.prompt.split("\n")[0]!.slice(0, 60) || "Subagent",
    mode: "stored",
    status: "idle",
    updatedAt: storeStamp(nativeId)?.at ?? Date.now(),
    parentSessionId: `antigravity:${meta.parent}`,
    ...(meta.toolId ? { parentToolId: meta.toolId } : {}),
    ...(meta.type ? { agentType: meta.type } : {}),
  };
}

/** A parent's transcript with each subagent call's card linked to its subagent's session. */
function linked(parent: string, msgs: Msg[]): Msg[] {
  const calls = subagentCalls(msgs);
  if (!calls.length) return msgs;
  const byCall = new Map([...matchCalls(childrenOf(parent), calls)].map(([child, call]) => [call.toolId, `antigravity:${child}`]));
  if (!byCall.size) return msgs;
  return msgs.map((m) => (m.parts.some((p) => p.type === "tool" && byCall.has(p.id)) ? { ...m, parts: m.parts.map((p) => (p.type === "tool" && byCall.has(p.id) ? { ...p, childSessionId: byCall.get(p.id)! } : p)) } : m));
}

/**
 * A conversation's transcript. A subagent's starts with its prompt, under the id the core gives it
 * when it starts live (`<id>:prompt`): its own replay leaves the parent's message out.
 */
async function history(nativeId: string, projectPath: string): Promise<Msg[]> {
  const msgs = (await reader.replay(nativeId, projectPath)).msgs;
  const child = childInfo(nativeId);
  if (!child) return linked(nativeId, msgs);
  const text = childMeta.get(nativeId)?.prompt || child.prompt;
  return [{ id: `${nativeId}:prompt`, role: "user", ts: stampOf(nativeId, () => child.at)(-1), parts: [{ type: "text", text }] }, ...msgs];
}

export const antigravityAdapter: Adapter = {
  id: "antigravity",
  capabilities: { canSteer: false, terminal: "handoff", subagents: { view: true, stop: true, steer: "via-parent" }, commands: true, move: { import: "context" }, fork: true, readOnlyMode: "default" },
  fork: agyFork,
  toolServer: (server) => agyTools.set(server),
  move: {
    // Plan changes nothing without asking; default asks before edits and commands; accept-edits edits.
    modes: [
      { mode: "plan", level: LEVELS.readOnly },
      { mode: "default", level: LEVELS.ask },
      { mode: "accept-edits", level: LEVELS.edits },
      { mode: BYPASS, level: LEVELS.full },
    ],
    contextWindow: async () => [...seenContext.values()].at(-1)?.total ?? 1_048_576,
  },

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
    if (s) return summary(s);
    // A subagent isn't listed: its parent says what it is.
    const child = childInfo(nativeId);
    if (!child) return undefined;
    const meta = childMeta.get(nativeId) ?? { parent: child.parent, prompt: child.prompt };
    const parent = (await reader.list()).find((x) => x.sessionId === child.parent);
    return parent ? childSummary(nativeId, parent.cwd, meta) : undefined;
  },

  storeChangedAt: (nativeId) => storeStamp(nativeId)?.at,
  storeRevision: (nativeId) => storeStamp(nativeId)?.rev,
  noStore: async (nativeId) => !hasStore(nativeId),

  listSubagents: (nativeId, projectPath) => subagentsOf(nativeId, projectPath),

  readHistory: history,

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
          const msgs = await history(nativeId, projectPath);
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
    // Bypass permissions in the TUI: its own switch for it.
    if (opts.permissionMode === BYPASS) argv.push("--dangerously-skip-permissions");
    return { argv, quit: AGY_QUIT, quitAtPrompt: AGY_EXIT, screen: agyScreen };
  },
};
