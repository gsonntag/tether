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
  listModels(live?: LiveSession): Promise<{ models: ModelRef[]; thinkingLevels: string[]; permissionModes: string[] }>;
}
