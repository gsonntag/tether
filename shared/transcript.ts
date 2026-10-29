// The transcript and live state of a session, as every harness is shown (SPEC §5). Adapters
// translate their harness's own store and stream into these shapes; the UI renders only these.

export type HarnessId = "claude" | "codex";

export const HARNESS_LABELS: Record<HarnessId, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

// ---------- transcript ----------

export type ToolStatus = "running" | "done" | "error";
/** A tool call by what it does, whatever the harness names it. The UI renders tool cards by kind. */
export type ToolKind = "shell" | "edit" | "write" | "read" | "search" | "fetch" | "todo" | "task" | "other";

export interface ToolPart {
  type: "tool";
  id: string;
  name: string;
  kind: ToolKind;
  input: unknown;
  status: ToolStatus;
  output?: string;
  /** the command a shell call runs */
  command?: string;
  /** the file (or folder) a read, edit or write is about */
  path?: string;
  /** set when the call ran inside a subagent */
  parentToolId?: string;
}

export type Part =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | ToolPart;

export type Role = "user" | "assistant" | "notice";

export interface Msg {
  id: string;
  role: Role;
  parts: Part[];
  ts: number;
  /** assistant: the model that produced it */
  model?: string;
  /** notice: severity */
  level?: "info" | "warning" | "error";
  /** assistant: the turn ended in this error */
  error?: string;
  streaming?: boolean;
}

// ---------- live state ----------

export type SessionMode = "stored" | "live" | "terminal";
export type RunStatus = "idle" | "running" | "waiting";

/** An approval or question waiting for a person (SPEC §7). */
export interface Request {
  id: string;
  sessionId: string;
  kind: "approval" | "question";
  tool?: string;
  input?: unknown;
  question?: string;
  options?: string[];
  openedAt: number;
}

export interface QueuedMessage {
  id: string;
  text: string;
  queuedAt: number;
}

export interface LiveState {
  mode: SessionMode;
  status: RunStatus;
  model?: string;
  effort?: string;
  permissionMode?: string;
  requests: Request[];
  queue: QueuedMessage[];
  /** set while the session is in terminal mode */
  terminal?: { kind: "handoff" | "shared" };
  error?: string;
}

/** One row in the sidebar and Home. */
export interface SessionSummary {
  /** `${harness}:${nativeId}` */
  id: string;
  harness: HarnessId;
  nativeId: string;
  projectPath: string;
  title: string;
  mode: SessionMode;
  status: RunStatus;
  updatedAt: number;
  /** open requests, for the status dot and Home */
  requests?: number;
}

export interface SessionSnapshot {
  session: SessionSummary;
  messages: Msg[];
  state: LiveState;
  /** the seq of the last event folded into this snapshot */
  seq: number;
}

// ---------- session events (runner -> server -> subscribed browsers) ----------

export type SessionEvent =
  /** insert or replace by id */
  | { type: "msg"; msg: Msg }
  /** streamed text appended to a text or thinking part */
  | { type: "delta"; msgId: string; part: number; text: string }
  | { type: "tool"; msgId: string; toolId: string; patch: Partial<ToolPart> }
  | { type: "state"; state: Partial<LiveState> }
  /** replace the transcript (after compaction) */
  | { type: "reset"; messages: Msg[] };
