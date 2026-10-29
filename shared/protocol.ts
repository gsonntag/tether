// The wire format between browsers, the relay (server) and runners (SPEC §5).
//
//   browser ──rpc {id, runnerId, op, args}──► server ──rpc {id', op, args}──► runner
//   browser ◄──────result {id, ok, …}──────── server ◄──result {id', ok, …}── runner
//   browser ◄──event {runnerId, sessionId, seq}── server ◄──event {sessionId, seq}── runner   (subscribers only)
//   browser ◄──summary {runnerId, summary}─────── server ◄──summary {summary}─────── runner   (every browser)
//   browser ◄──term {attachId, data}───────────── server ◄──term {attachId, data}─── runner   (the attaching browser only)
//
// The server is stateless about sessions. It knows only which runners are connected, which
// browser subscribed to which session, and which browser owns which terminal attach.
//
// Watching: the server tells the runner `unwatched` when the last browser subscribed to a
// session goes away (unsubscribe, a failed subscribe, or the browser disconnecting), so the
// runner can stop tailing what nobody looks at. A new runner connection starts with no watchers.
//
// Slow sockets: the server never drops a frame silently. A browser or runner that can't keep up
// (its send buffer passes the limit) is disconnected; it reconnects, subscribes again for fresh
// snapshots and reattaches terminals, which tmux redraws. Terminal output therefore needs no
// replay: a gap in a terminal stream only ever happens with a reattach.
//
// Sync: `subscribe` answers with a SessionSnapshot. Events for that session reach the browser
// from the moment the server forwards the subscribe, so a few may arrive before the snapshot;
// the browser keeps those with seq > snapshot.seq (shared/sync.ts). Any gap or reconnect means
// subscribe again for a fresh snapshot.

import type { PartChunk } from "./limits";
import type { HarnessId, ModelList, Msg, ProjectInfo, RequestAnswer, SessionEvent, SessionSnapshot, SessionSummary } from "./transcript";

/** Close code the server uses for a runner connection that a newer one with the same id replaced. */
export const CLOSE_REPLACED = 4000;
/** Close code for a socket whose send buffer passed the limit. */
export const CLOSE_TOO_SLOW = 4002;
/** Close code for a runner whose protocol version differs from the server's. */
export const CLOSE_PROTOCOL = 4003;

/** Bumped when a change needs runner, server and web to move together. */
export const PROTOCOL_VERSION = 2;

export interface HarnessInfo {
  id: HarnessId;
  /** as the CLI reports it, e.g. "2.1.312" */
  version: string;
}

export interface RunnerInfo {
  /** stable and unique: generated once and kept in runner.json */
  id: string;
  /** what people see; defaults to the hostname */
  name: string;
  hostname: string;
  /** the runner's own version */
  version: string;
  protocol: number;
  /** installed harnesses */
  harnesses: HarnessInfo[];
  /** set by the server: when this connection said hello */
  connectedAt?: number;
}

export interface User {
  name: string;
  email: string;
}

// ---------- ops (browser -> runner, answered with a result) ----------

/** Op name -> its args and result. Later phases add the rest of the core ops (SPEC §5). */
export interface Ops {
  /** a round trip through the relay to the runner */
  ping: { args: Record<string, never>; result: { runnerId: string; at: number } };
  /** start receiving a session's events; answers with a fresh snapshot of the newest `limit` messages */
  subscribe: { args: { sessionId: string; limit?: number }; result: SessionSnapshot };
  /**
   * A part in full, when a snapshot or event cut it short (`truncated`, `inputTruncated`) or left
   * it out (`partsOmitted`). It comes as a slice of its JSON from `offset`, at most about 1 MB per
   * answer: ask again from `offset + chunk.length` until `done`, then parse the joined string
   * (shared/limits.ts `partChunk`).
   */
  fullPart: { args: { sessionId: string; msgId: string; part: number; offset?: number }; result: PartChunk };
  /** an older page of a transcript: up to `limit` messages before the message `before` */
  history: { args: { sessionId: string; before: string; limit?: number }; result: { messages: Msg[]; hasOlder: boolean } };
  /** stop receiving a session's events (answered by the server) */
  unsubscribe: { args: { sessionId: string }; result: null };

  // ---------- discovery (read-only: never starts a harness process) ----------

  /** folders with sessions, newest activity first */
  listProjects: { args: Record<string, never>; result: { projects: ProjectInfo[] } };
  /**
   * Sessions. Without filters: the runner's summary list (the sidebar's recent sessions, plus every
   * live one), with the `epoch` and `seq` it is current to (protocol.ts SummaryUpdate). With
   * `projectPath`: every session in that folder. With `parentSessionId`: that session's subagents.
   * With `query`: sessions whose title contains it. Newest first.
   */
  listSessions: {
    args: { projectPath?: string; parentSessionId?: string; query?: string; limit?: number };
    result: { sessions: SessionSummary[]; epoch?: string; seq?: number };
  };
  /** the models, effort levels and permission modes a harness offers (for a session: as it runs now) */
  listModels: { args: { harness: HarnessId; sessionId?: string }; result: ModelList };

  // ---------- driving ----------

  /**
   * A new session in a folder (a path on the runner; `~` is the home folder). The harness starts
   * right away so a problem (not signed in, no such folder) shows before you type.
   */
  newSession: {
    args: { harness: HarnessId; projectPath: string; model?: string; effort?: string; permissionMode?: string };
    result: { sessionId: string };
  };
  /** starts a turn; a stored session goes live first (SPEC §4) */
  send: { args: { sessionId: string; text: string }; result: null };
  /** stops the running turn; on a subagent, stops that subagent */
  interrupt: { args: { sessionId: string }; result: null };
  /** saved for the session and applied now when it is live, else when it next starts */
  setModel: { args: { sessionId: string; model: string }; result: null };
  setEffort: { args: { sessionId: string; effort: string }; result: null };
  setPermissionMode: { args: { sessionId: string; mode: string }; result: null };
  /**
   * Answers an open request (SPEC §7). The first answer wins: a request already answered, here or
   * on another device, fails with "Already answered."; one that closed otherwise (stopped, resolved
   * in the harness's own UI) with "That request is no longer open."
   */
  answerRequest: { args: { sessionId: string; requestId: string } & RequestAnswer; result: null };
  /** attach this browser to a terminal; the server fills in attachId */
  openTerminal: { args: { sessionId: string; attachId?: string; cols: number; rows: number }; result: { attachId: string } };
  closeTerminal: { args: { attachId: string }; result: null };
  /** base64 bytes typed into an attached terminal */
  terminalInput: { args: { attachId: string; data: string }; result: null };
  terminalResize: { args: { attachId: string; cols: number; rows: number }; result: null };
}

export type OpName = keyof Ops;
export type OpArgs<K extends OpName> = Ops[K]["args"];
export type OpResult<K extends OpName> = Ops[K]["result"];

/** Ops the server reads (and partly answers) instead of passing through blind. */
export const TERMINAL_OPS = ["closeTerminal", "terminalInput", "terminalResize"] as const satisfies readonly OpName[];

// ---------- summary channel (runner -> every browser) ----------

/**
 * The sidebar and Home: small, broadcast to every browser. `seq` counts the runner's summary
 * changes within one `epoch` (a random id each runner process picks at start), so a list fetched
 * by one rpc and updates broadcast around it can be put in order: anything not newer than what a
 * browser has is stale. A new epoch means the runner restarted and its seq started over: the
 * browser starts over too (shared/summary.ts). A browser that arrives later asks for the whole
 * list, which carries the epoch and seq it is current to.
 */
export type SummaryUpdate =
  /** the runner's whole list: broadcast on connect, and the answer to a list request */
  | { kind: "all"; epoch: string; seq: number; sessions: SessionSummary[] }
  | { kind: "upsert"; epoch: string; seq: number; sessions: SessionSummary[] }
  | { kind: "remove"; epoch: string; seq: number; ids: string[] };

// ---------- messages ----------

export interface ResultMsg {
  t: "result";
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export type BrowserToServer = { t: "rpc"; id: string; runnerId: string; op: OpName; args: unknown } | { t: "ping" };

export type ServerToBrowser =
  | { t: "hello"; user: User; protocol: number }
  /** every connected runner, sent on connect and whenever the set changes */
  | { t: "runners"; runners: RunnerInfo[] }
  | ResultMsg
  | { t: "event"; runnerId: string; sessionId: string; seq: number; event: SessionEvent }
  | { t: "summary"; runnerId: string; summary: SummaryUpdate }
  /** base64 terminal output, only to the browser that owns the attach */
  | { t: "term"; attachId: string; data: string }
  /** the attach is gone (the terminal exited, or its runner went away) */
  | { t: "termEnd"; attachId: string; reason?: string }
  | { t: "pong" };

export type ServerToRunner =
  | { t: "rpc"; id: string; op: OpName; args: unknown }
  /** these attaches lost their browser: close their PTYs */
  | { t: "detach"; attachIds: string[] }
  /** no browser watches these sessions any more */
  | { t: "unwatched"; sessionIds: string[] }
  /** the hello was accepted: the runner is connected from here on */
  | { t: "welcome" }
  /** answers the runner's keepalive ping */
  | { t: "pong" };

export type RunnerToServer =
  | { t: "hello"; runner: Omit<RunnerInfo, "connectedAt"> }
  | ResultMsg
  | { t: "event"; sessionId: string; seq: number; event: SessionEvent }
  | { t: "summary"; summary: SummaryUpdate }
  | { t: "term"; attachId: string; data: string }
  | { t: "termEnd"; attachId: string; reason?: string }
  /** keepalive; the server answers pong, so a dead connection shows up as silence */
  | { t: "ping" };
