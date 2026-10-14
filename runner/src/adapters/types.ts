import type { ContextUsage, HarnessId, ModelRef, Msg, SessionSummary } from "../../../web/src/shared/protocol";
import type { LiveSession, SessionSink } from "../session";

export type Sink = SessionSink;

export interface StoredProject {
  path: string;
  updatedAt: number;
  count: number;
}

export interface CreateOpts {
  model?: string;
  permissionMode?: string;
}

/** A stored conversation read without starting the agent, and what it tells about its settings. */
export interface StoredHistory {
  messages: Msg[];
  /** how full the context window was at its last request, when the store says */
  context?: ContextUsage;
  /** settings the harness's own store keeps (Tether's bookkeeping wins over these) */
  model?: string;
  thinking?: string;
  permissionMode?: string;
}

export interface Adapter {
  id: HarnessId;
  available(): Promise<boolean>;
  listProjects(): Promise<StoredProject[]>;
  listSessions(projectPath: string): Promise<SessionSummary[]>;
  /** Reads stored transcript history without adding a prompt to the session. */
  readHistory?(nativeId: string, projectPath: string): Promise<Msg[]>;
  /**
   * What opening a session that isn't running shows: its stored conversation, read without
   * starting the agent. Absent, or undefined for this session: only a running agent can replay it,
   * so opening starts one.
   */
  storedHistory?(nativeId: string, projectPath: string): Promise<StoredHistory | undefined>;
  /** What tells stored versions of a conversation apart besides its updatedAt (its file's size and time). */
  historyStamp?(nativeId: string, projectPath: string): Promise<string | undefined>;
  /** Modes the harness always offers, for the picker before its process has run. */
  modes?: string[];
  create(projectPath: string, opts: CreateOpts, sink: Sink): LiveSession;
  resume(nativeId: string, projectPath: string, sink: Sink): Promise<LiveSession>;
  /**
   * The harness's own fork (fork.ts): a new session, not started yet, holding the conversation of
   * `from` up to `point` (LiveSession.forkPoint: Claude Code's transcript entry, Codex's turn).
   * Absent: forks of its sessions go through a brief.
   */
  fork?(from: { nativeId: string; projectPath: string; point: string }, opts: CreateOpts, sink: Sink): Promise<LiveSession>;
  listModels(live?: LiveSession): Promise<{ models: ModelRef[]; thinkingLevels: string[]; permissionModes: string[] }>;
}
