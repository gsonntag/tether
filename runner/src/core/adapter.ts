// What the session core needs from a harness (SPEC §6). Adapters translate their harness's store
// and stream into the shared transcript shapes; they never talk to the UI or the relay. The core
// branches only on `capabilities`, never on the harness id.

import type { Attachment } from "../../../shared/attachments";
import type { CredentialSnapshot } from "../credentials";
import type { SessionCost } from "../../../shared/costs";
import type { Level, PortableItem } from "../../../shared/move";
import type { Billing, ContextUse, PlanUsage, HarnessCapabilities, HarnessId, LiveState, ModelList, Msg, ProjectInfo, Request, SessionEvent, SessionSummary, ToolPart } from "../../../shared/transcript";

/** Transcript events a driver reports. The core numbers them (seq) and keeps the transcript. */
export type TranscriptEvent = Extract<SessionEvent, { type: "msg" | "delta" | "tool" | "reset" }>;

export interface StartOpts {
  /** Rejoin a persistent process to observe its original turn after a runner restart. No send. */
  observe?: boolean;
  /** Ephemeral runner-only credential snapshot. Never persist or report this object. */
  credential?: CredentialSnapshot;
  model?: string;
  effort?: string;
  permissionMode?: string;
}

/**
 * How a permission request ended (SPEC §7): what the driver tells the harness. An allowed question
 * carries one answer per question; `mode` switches the permission mode with the approval (one of
 * the request's `approveAs`). A denial says why, for the model to read; `interrupt` also stops the
 * turn (a plain "Deny", as declining in the harness's own UI does).
 */
export type Decision = { allow: true; answers?: string[]; mode?: string } | { allow: false; reason: string; interrupt?: boolean };

/** What a driver asks: a Request without the fields the core fills in. */
export type RequestAsk = Omit<Request, "id" | "sessionId" | "openedAt" | "inputTruncated" | "agent">;

/**
 * The abort reason a driver gives a request's signal when the harness says it was answered
 * somewhere else (Codex's own TUI, SPEC §6): it closes as resolved elsewhere, not cancelled.
 */
export const RESOLVED_ELSEWHERE = "resolved-elsewhere";

/** A send that Stop cancelled before it reached the harness: nothing went out. */
export class SendCancelled extends Error {
  constructor() {
    super("Stopped before it went out.");
  }
}

/** A subagent the driver saw start: it becomes a child session (SPEC §6a). */
export interface SubagentStart {
  /** the child's native id, unique within the harness */
  nativeId: string;
  /** the tool call in the parent that started it */
  parentToolId: string;
  title: string;
  agentType?: string;
  /** its prompt, shown as its first message */
  prompt?: string;
}

/**
 * Where a driver reports. One per session; a subagent gets its own (from `subagent`), so its
 * turns land in its own transcript.
 */
export interface Sink {
  /** A cumulative API cost epoch; replays of the same id replace its previous report. No keys. */
  cost?(report: SessionCost & { id: string }): void;
  event(e: TranscriptEvent): void;
  /** the message as the transcript has it now (to build an upsert from) */
  message(id: string): Msg | undefined;
  state(patch: Partial<Omit<LiveState, "mode" | "requests" | "queue">>): void;
  /**
   * A permission prompt or question: the broker decides (SPEC §7). Abort `signal` when the harness
   * no longer waits (the turn stopped): the request closes as cancelled, or as resolved elsewhere
   * with the reason RESOLVED_ELSEWHERE. The promise then settles with a denial nobody reads.
   */
  request(r: RequestAsk, signal?: AbortSignal): Promise<Decision>;
  /** the harness reported the account's plan limits: partial, merged into what's known */
  plan?(p: PlanUsage): void;
  /** the native id became known or changed (a new session's id comes with the harness's first answer) */
  nativeId?(id: string): void;
  /** a subagent started under this session: its sink */
  subagent(s: SubagentStart): Sink;
  /** a subagent of this sink's session ended */
  ended?(): void;
  /** the harness reports the main agent sent this subagent a message (subagents.steer "via-parent") */
  relayed?(nativeId: string): void;
  /** the main agent's turn ended, and only background work keeps the session running: Driver.onlyBackground */
  mainFree?(): void;
  /** Driver.onlyBackground changed */
  mainChanged?(): void;
}

export interface Driver {
  /** Actual credential revision of the process, including a rejoined process on an older key. */
  readonly credentialRevision?: string;
  readonly nativeId: string;
  /**
   * Starts a turn. `attachments` are files under the runner's attachments folder; the text already
   * lists them (shared/attachments.ts withAttachments), and images the harness reads natively go to
   * it as images too.
   */
  /** `shown`: the session's settings as Tether shows them (a driver that pins them on the turn: pinsSettings) */
  send(text: string, attachments?: Attachment[], shown?: StartOpts): Promise<void>;
  /** the harness takes the shown settings with each turn (turn/start), so a turn Tether starts runs exactly them */
  readonly pinsSettings?: boolean;
  /** a message into the running turn (capabilities.canSteer) */
  steer?(text: string, attachments?: Attachment[]): Promise<void>;
  interrupt(): Promise<void>;
  setModel(model: string): Promise<void>;
  setEffort?(effort: string): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  /** stops one running subagent (capabilities.subagents.stop) */
  stopSubagent?(nativeId: string): Promise<void>;
  /** moves a foreground subagent, started by this tool call, to the background (capabilities.subagents.background) */
  backgroundSubagent?(toolId: string): Promise<void>;
  /** the main agent is free and only background work keeps the session running: a message starts its next turn now */
  onlyBackground?(): boolean;
  /** Ends the commands in background terminals running with more access than the session shows. */
  stopBackground?(): Promise<void>;
  /** a message into a running subagent's turn, as the person (capabilities.subagents.steer "direct") */
  steerSubagent?(nativeId: string, text: string, attachments?: Attachment[]): Promise<void>;
  /**
   * capabilities.subagents.steer "via-parent" (SPEC §6a): the message that asks the main agent to
   * pass `text` on to the subagent, and whether a tool call of the main agent's is that delivery
   * (a harness that reports deliveries instead says so through the sink: `relayed`).
   */
  relayMessage?(nativeId: string, text: string): string;
  relayedBy?(nativeId: string, tool: ToolPart, text?: string): boolean;
  /** the harness's own TUI is about to join this live session (capabilities.terminal "shared") */
  beforeTerminal?(): Promise<void>;
  /** a turn is running in the harness right now (one another client started, found on joining) */
  turnRunning?(): boolean;
  /** work still running after the turn (background subagents, shells): the session isn't idle-closed */
  busy(): boolean;
  close(): Promise<void>;
  /** Retire an owned idle backing process. Never used for runner shutdown or a live TUI. */
  retire?(): Promise<void>;
  /** the process ended by itself (crashed, logged out, …): `error` says why when known */
  onExit?: (error?: string) => void;
}

/** One move into a new session (SPEC §15): `nativeId` is empty, from `newId`. */
export interface ImportRequest {
  nativeId: string;
  projectPath: string;
  title: string;
  /** the conversation, oldest first; the first is Tether's own opening */
  items: PortableItem[];
}

/**
 * What a harness does to move sessions (SPEC §15): written once, it works with every other harness,
 * as all of them go through the neutral format in shared/move.ts. `capabilities.move` says which
 * route it has.
 */
export interface AdapterMove {
  /** The whole transcript with what `readHistory` leaves out (compaction summaries). Absent: readHistory. */
  exportHistory?(nativeId: string, projectPath: string): Promise<Msg[]>;
  /** Puts the items in the new session's history, and its title. Throws, leaving nothing, when it can't. */
  importHistory?(r: ImportRequest): Promise<void>;
  /** Whether the imported history is really there (the check after `importHistory`). */
  imported?(r: ImportRequest): Promise<boolean>;
  /** Names a session started by the context route. */
  setTitle?(nativeId: string, projectPath: string, title: string): Promise<void>;
  /** The harness's own modes, each with its level. */
  modes: { mode: string; level: Level }[];
  /** A mode's level, for one not in `modes` (a combination); undefined: unknown, which is the safest. */
  levelOf?(mode: string): Level | undefined;
  /** The model's context window in tokens, when known. */
  contextWindow?(model: string | undefined): Promise<number | undefined>;
  /** A client outside Tether is running a turn on it. */
  busy?(nativeId: string): Promise<boolean>;
}

export interface Adapter {
  id: HarnessId;
  capabilities: HarnessCapabilities;
  available(): Promise<boolean>;
  // discovery and history: read-only, no process
  listProjects(): Promise<ProjectInfo[]>;
  /** sessions with activity since `since` (all when absent); `projectPath` narrows to one folder */
  listSessions(opts?: { projectPath?: string; since?: number }): Promise<SessionSummary[]>;
  /** one session's summary (title, folder, times) when it is stored */
  sessionInfo(nativeId: string, projectPath?: string): Promise<SessionSummary | undefined>;
  /**
   * When the session's store last changed (ms), for a harness whose process can outlive the runner
   * (a crash): Tether waits for it to go quiet before continuing a cut-off turn (SPEC §4).
   */
  storeChangedAt?(nativeId: string, projectPath: string): number | undefined;
  /** whether a stored session left something running in its harness (read-only: joins nothing) */
  backgroundRuns?(nativeId: string): Promise<boolean>;
  /** a session's stored subagents, as child summaries */
  listSubagents(nativeId: string, projectPath: string): Promise<SessionSummary[]>;
  readHistory(nativeId: string, projectPath: string): Promise<Msg[]>;
  /** A session whose store holds no conversation, only local commands (/exit, /clear typed in an untouched TUI). */
  neverStarted?(nativeId: string, projectPath: string): Promise<boolean>;
  /**
   * The session's store on its permission mode: how many mode entries it has, and the last one's mode.
   * Claude writes one with each turn and when it exits, so Shift+Tab alone reaches it only then.
   */
  storedMode?(nativeId: string, projectPath: string): Promise<{ mode?: string; entries: number }>;
  /** The session's context as its store has it (SPEC §5). Undefined: not known. Starts nothing. */
  storedContext?(nativeId: string, projectPath: string): Promise<ContextUse | undefined>;
  /** What a stored session drew from on its latest start: unknown if that wasn't recorded. */
  storedBilling?(nativeId: string, projectPath: string): Promise<Billing>;
  /** The account's plan limits, as far as they're known without a turn (SPEC §5). Starts nothing. */
  planUsage?(): Promise<PlanUsage | undefined>;
  /** calls onChange with the whole transcript whenever the store changes; returns the stop function */
  watchHistory(nativeId: string, projectPath: string, onChange: (msgs: Msg[]) => void): () => void;
  /**
   * The settings a stored session has, for its live state before it starts: the harness's own config
   * for the folder, or (`nativeId`, for a harness that keeps settings per session) that session's.
   */
  defaults(projectPath: string, nativeId?: string): Promise<StartOpts>;
  /**
   * For a harness Tether always tells its model and effort (Claude): what it runs with where they're
   * neither set in Tether nor known from `defaults`, each on its own. Absent: left to the harness.
   */
  unset?: { model: string; effort: string };
  // live driving
  start(projectPath: string, nativeId: string, opts: StartOpts, sink: Sink): Promise<Driver>;
  resume(nativeId: string, projectPath: string, opts: StartOpts, sink: Sink): Promise<Driver>;
  listModels(driver?: Driver): Promise<ModelList>;
  /**
   * Whether a model id in this harness's transcripts is one of its own (Claude: "claude-…"), so a
   * model picked in its TUI can be carried back to the session. Absent: any.
   */
  ownModel?(model: string): boolean;
  /** where settings change in this harness's own TUI, for a refusal while it drives ("/model, Shift+Tab") */
  terminalSettingsHint?: string;
  /**
   * A new session's native id: chosen by Tether (Claude: a UUID; SPEC §6 terminal), or made by the
   * harness when it picks its own ids (Codex: a thread in its daemon, which `start` then joins).
   */
  newId(projectPath: string, opts: StartOpts): string | Promise<string>;
  /**
   * For a harness that can't start a new session's id a second time (Codex: a thread with nothing on
   * disk can't be joined once its connection closes): a new id for the same folder, and the settings
   * it starts with.
   */
  renew?(projectPath: string, opts: StartOpts): Promise<{ nativeId: string; opts: StartOpts }>;
  /** The harness knows the id but has stored nothing under it (Codex: a thread without a rollout). */
  noStore?(nativeId: string): Promise<boolean>;
  // terminal mode (SPEC §8): how to run the harness's own TUI on a session, in tmux
  terminalCommand(nativeId: string, projectPath: string, opts: TerminalOpts): TerminalLaunch;
  /** Async, read-only source preflight, only when a TUI is actually about to start. */
  prepareTerminal?(nativeId: string, projectPath: string, opts: TerminalOpts): Promise<Billing>;
  /** moving sessions to and from this harness (SPEC §15); with `capabilities.move` */
  move?: AdapterMove;
}

export interface TerminalOpts extends StartOpts {
  /** a new session: the TUI creates it under `nativeId` (Claude: --session-id) instead of resuming */
  fresh?: boolean;
  /**
   * Where the TUI reports "needs you" and its mode (handoff harnesses, SPEC §8): the adapter
   * wires its harness's own hooks to POST there (terminal/hooks.ts).
   */
  report?: { socketPath: string; sessionId: string; tui?: string };
}

/**
 * What a TUI's screen shows (tmux capture-pane): `idle` at its prompt with nothing running; `busy`
 * working; `asking` a question; `picker` one of the harness's own menus (/model: nobody is asked
 * anything); `unknown` anything else (starting, a full-screen view).
 */
export interface ScreenRead {
  state: "idle" | "busy" | "asking" | "picker" | "unknown";
  /** what is typed at the prompt (idle or busy), when the harness can tell */
  input?: string;
  /** the prompt's mode (idle or busy): `normal`, or a shell line, a recalled prompt, a history search, vim's NORMAL mode */
  prompt?: "normal" | "shell" | "history" | "search" | "vim";
  /** the permission mode its status line shows (idle or busy), when the harness can tell */
  mode?: string;
  /** its status line shows background shells: quitting stops them */
  background?: boolean;
}

/** One step of quitting a TUI: tmux key names, literal text, or a pause. */
export type QuitStep = { keys: string[] } | { text: string } | { waitMs: number };

export interface TerminalLaunch {
  /** The source the harness confirmed during this launch's preflight. Contains no credential. */
  billing?: Billing;
  argv: string[];
  env?: Record<string, string>;
  /** how to ask the TUI to quit (Back to Tether); the core kills it if it hasn't after a while */
  quit?: QuitStep[];
  /** a clean way to quit when the TUI sits at its plain, empty prompt (Claude: /exit) */
  quitAtPrompt?: QuitStep[];
  /**
   * Reads the TUI's screen (tmux capture-pane). Tether doesn't follow the TUI's turns; the screen
   * only says whether a question is up (Needs you after a runner restart; it clears once the prompt
   * shows again) and whether the TUI sits at an empty prompt (a clean quit).
   */
  screen?: (screen: string) => ScreenRead;
}
