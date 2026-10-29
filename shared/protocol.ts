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
// Sync: `subscribe` answers with a SessionSnapshot. Events for that session reach the browser
// from the moment the server forwards the subscribe, so a few may arrive before the snapshot;
// the browser keeps those with seq > snapshot.seq (shared/sync.ts). Any gap or reconnect means
// subscribe again for a fresh snapshot.

import type { HarnessId, Msg, SessionEvent, SessionSnapshot, SessionSummary } from "./transcript";

/** Bumped when a change needs runner, server and web to move together. */
export const PROTOCOL_VERSION = 1;

export interface HarnessInfo {
  id: HarnessId;
  /** as the CLI reports it, e.g. "2.1.312" */
  version: string;
}

export interface RunnerInfo {
  id: string;
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
  /** an older page of a transcript: up to `limit` messages before the message `before` */
  history: { args: { sessionId: string; before: string; limit?: number }; result: { messages: Msg[]; hasOlder: boolean } };
  /** stop receiving a session's events (answered by the server) */
  unsubscribe: { args: { sessionId: string }; result: null };
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

/** The sidebar and Home: small, broadcast to every browser. */
export type SummaryUpdate =
  /** the runner's whole list, sent on connect */
  | { kind: "all"; sessions: SessionSummary[] }
  | { kind: "upsert"; sessions: SessionSummary[] }
  | { kind: "remove"; ids: string[] };

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
