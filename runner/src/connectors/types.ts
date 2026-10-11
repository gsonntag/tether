// A connector maps Tether's canonical config (shared memory, skills, the `tether-context` MCP
// server, later the MCP registry, commands, agents, hooks and env) onto one harness. The driver
// (runner/src/adapters/) runs turns; it asks the connector what to add to a launch instead of
// wiring each feature itself. Every slot says how the harness supports it (capability), what a
// session launch needs (forSession) and, where the harness has native config files, how Tether
// writes them (exportGlobal). The MCP slot also reads the harness's own servers (importGlobal,
// native) and names the config files the MCP registry exports to (targets).

import type { CapabilityLevel, HarnessId, McpTransport, SlotCapability, SlotId } from "../../../web/src/shared/protocol";
import type { ExportResult } from "../context/export";
import type { SessionContext } from "../context/inject";
import type { SkillDir } from "../context/skills";
import type { Store } from "../context/store";
import type { Flavor } from "../mcp/formats";
import type { Found, Scan } from "../mcp/sources";

export type { CapabilityLevel, SlotCapability, SlotId };

/** What a session launch knows when it asks its connector. */
export interface SessionCtx {
  projectPath: string;
  /** Tether session id (once the harness has one) and guard key, for the `tether-context` env */
  session?: { id?: string; key?: string };
  /** resuming an existing native session (no first-message preamble) */
  resume?: boolean;
  /** the master context for this session; undefined while the feature is off */
  context?: SessionContext;
  /** MCP registry servers for this session: on, in scope, and not already in the harness's own config */
  servers?: SessionServer[];
  /** ACP: the agent's `mcpCapabilities` from initialize (HTTP and SSE servers only when it has them) */
  mcpCapabilities?: { http?: boolean; sse?: boolean };
}

/** A registry server as a launch gets it (credentials attached: an OAuth token as an Authorization header). */
export interface SessionServer {
  name: string;
  transport: McpTransport;
}

/** One slot's (or the whole connector's) contribution to a launch. */
export interface SessionLaunch {
  /** CLI arguments (pi) */
  args: string[];
  /** SDK or protocol options: Claude query options, Codex thread params, ACP newSession fields */
  options: Record<string, any>;
  /** environment for the harness process */
  env: Record<string, string>;
  /** goes in front of the first message (harnesses without a system-prompt hook) */
  preamble?: string;
  /** registry servers this session would get that still need an OAuth sign-in (shown inline) */
  mcpAuth?: { id: string; name: string; status: "needs" | "expired" }[];
}

/** What a global export can do; the helpers keep export.ts's data-safety rules (snapshots, own-write marks). */
export interface ExportContext {
  store: Store;
  out: ExportResult;
  /** the store's exports/global.md, which @imports point at */
  globalFile: string;
  /** the global digest text */
  digest: string;
  readText(path: string): string;
  /** writes a file Tether owns or a managed block's file, recording the original first */
  writeOwned(path: string, text: string): void;
  /** records a file's original state before Tether changes or removes it */
  remember(path: string, createdDir?: boolean): void;
  /** registers `tether-context` in a `{"mcpServers": {...}}` file when `installed` exists */
  registerJsonMcp(path: string, installed: string): void;
  /** this repo key's memory digest, when it has any */
  repoDigest(key: string): string | undefined;
}

export interface Slot {
  capability(): SlotCapability;
  forSession?(ctx: SessionCtx): Partial<SessionLaunch> | undefined;
  exportGlobal?(x: ExportContext): void | Promise<void>;
}

export interface MemorySlot extends Slot {
  /** the global instructions file (CLAUDE.md, AGENTS.md, GEMINI.md) that gets a managed block, and its content */
  globalBlock?(globalFile: string, digest: string): [path: string, content: string];
  /** per-repo memory files (Claude's project memory dirs) */
  exportRepos?(x: ExportContext): void | Promise<void>;
}

export interface McpSlot extends Slot {
  /**
   * The global config is one the harness itself keeps writing (~/.claude.json, opencode's config):
   * only the user's own import registers there, never a background re-export.
   */
  sharedConfig?: boolean;
  /** the MCP servers in the harness's own global config (the registry's import) */
  importGlobal?(): Scan;
  /** the servers the harness loads by itself in a session in `projectPath` (Decision 2: never injected again) */
  native?(projectPath: string): Found[];
  /** how a registry server with this transport reaches the harness */
  deliver(t: McpTransport): McpRoute;
  /** the global config files the registry's export writes (installed or not) */
  targets?(): McpTarget[];
}

export interface McpRoute {
  /** session: per-session injection; global: only through its global config; none: can't */
  how: "session" | "global" | "none";
  note: string;
}

/** A harness config file the MCP registry exports global servers into. */
export interface McpTarget {
  file: string;
  /** the harness is set up here (its dir exists) */
  installed: boolean;
  /** json: `{ <key>: { name: entry } }`, edited in place; toml: Codex's managed block */
  format: "json" | "toml";
  key?: string;
  flavor: Flavor;
  /** comments and trailing commas allowed */
  jsonc?: boolean;
}

/** A harness skill dir as a session reads it (read only). */
export interface HarnessSkillDir {
  dir: string;
  /** the badge shown in the `/` menu */
  source: string;
  /** repo dirs: the repo root its skills must stay inside */
  root?: string;
}

export interface SkillsSlot extends Slot {
  /** how the harness is told to run one of its own skills */
  invoke(name: string, args: string): string;
  /** the dirs this harness reads skills from for a project, nearest first */
  dirs(projectPath: string): HarnessSkillDir[];
  /** with no live answer, a skill in one of its dirs still runs natively (else it's expanded) */
  offline: boolean;
  /** the global dirs the registry links skills into (or imports from) */
  installDirs(): SkillDir[];
}

export interface Connector {
  id: HarnessId;
  mcp: McpSlot;
  skills: SkillsSlot;
  memory: MemorySlot;
  commands: Slot;
  agents: Slot;
  hooks: Slot;
  env: Slot;
  /** /goal (runner/src/goal.ts): native when the harness's own goal mirrors Tether's, else Tether's loop */
  goal: Slot;
  /** a plan review before changes (runner/src/plan.ts): the harness's own, or Tether's card and guard */
  plan: Slot;
  /** the session's todo list: the harness's own todo tool, or todo_set */
  todos: Slot;
  /** questions to the user: the harness's own question tool, or ask_user */
  ask_user: Slot;
  /** /loop and /schedule (runner/src/schedule.ts): run by the runner, sent as queued messages */
  schedules: Slot;
}

export const SLOTS: SlotId[] = ["mcp", "skills", "memory", "commands", "agents", "hooks", "env", "goal", "plan", "todos", "ask_user", "schedules"];
