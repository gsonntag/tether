import type { HarnessId, ModelRef, Msg, SessionSummary } from "../../../web/src/shared/protocol";
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

export interface Adapter {
  id: HarnessId;
  available(): Promise<boolean>;
  listProjects(): Promise<StoredProject[]>;
  listSessions(projectPath: string): Promise<SessionSummary[]>;
  /** Reads stored transcript history without adding a prompt to the session. */
  readHistory?(nativeId: string, projectPath: string): Promise<Msg[]>;
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
