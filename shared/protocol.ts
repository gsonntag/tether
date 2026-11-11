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

import type { HarnessCommand } from "./commands";
import type { MoveOptions } from "./move";
import type { Attachment } from "./attachments";
import type { AzureDeployment, BillingSource, CredentialSource, CredentialStatus, SourceChoices } from "./credentials";
import type { TokenRates } from "./costs";
import type { HarnessReport } from "./harnessUpdates";
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
  /** the Home agent's folder: its chats show on Home, never in the lists. Absent: no Home agent */
  homeFolder?: string;
}

/** Runner-wide settings (the Settings page), kept in runner.json. */
export interface RunnerSettings {
  /** Claude: every subagent the agent starts runs in the background (its Agent call is made with run_in_background) */
  backgroundSubagents?: boolean;
  /** sessions Tether runs are told to end each turn with a short reply (SPEC §9a); absent: on, `false`: off. Never the Home agent */
  conciseReplies?: boolean;
}

/** What the Home agent runs on (runner/src/modules/homeAgent). No model: the harness's default. */
export interface HomeAgentSettings {
  harness: HarnessId;
  source: BillingSource;
  /** on Azure, a deployment's name */
  model?: string;
  /** the permission mode its own chat runs in, one of the harness's (ModelList.permissionModes). None: auto (HOME_AGENT_MODE) */
  mode?: string;
}

/** The Home agent's mode when none is chosen: auto, or the harness's nearest below it. */
export const HOME_AGENT_MODE = "auto";

export interface User {
  name: string;
  email: string;
  /** Their Foliation profile picture (the identity token's `picture` claim), absent when they have none. */
  picture?: string;
}

// ---------- ops (browser -> runner, answered with a result) ----------

/** Op name -> its args and result. Later phases add the rest of the core ops (SPEC §5). */
export interface Ops {
  retryNow: { args: { sessionId: string }; result: null };
  cancelRetry: { args: { sessionId: string }; result: null };
  credentials: { args: Record<string, never>; result: CredentialStatus };
  setCredential: { args: { source: CredentialSource; key: string; endpoint?: string; deployment?: string; rates?: TokenRates }; result: CredentialStatus };
  unsetCredential: { args: { source: CredentialSource }; result: CredentialStatus };
  /** Azure's endpoint (a resource name or a URL) and its deployments, replacing what was there. Its key is untouched */
  setAzure: { args: { endpoint: string; deployments: AzureDeployment[] }; result: CredentialStatus };
  /** one tiny request to a saved deployment, the way a session's requests go: real Azure usage, only when asked */
  testAzure: { args: { deployment: string }; result: { ok: boolean; text: string } };
  /** the sources a harness can use now, and which to show first. A runner without it hides the picker */
  billingSources: { args: { harness: HarnessId }; result: SourceChoices };
  /** a session's source from its next process start (only with capabilities.sourceSwitch) */
  setSessionSource: { args: { sessionId: string; source: BillingSource }; result: null };
  /** the box in the billing chip's menu (`on`) and/or the session's fallback key order; each alone leaves the other */
  setAutoKey: { args: { sessionId: string; on?: boolean; fallbackKeys?: CredentialSource[] }; result: null };
  /** asks the harness for its plan limits if it has a cheap read; the answer comes as session state */
  refreshPlan: { args: { harness: HarnessId }; result: null };
  renameSession: { args: { sessionId: string; title: string }; result: null };
  /** Keeps a session out of Recent; archived sessions remain searchable. */
  setSessionArchived: { args: { sessionId: string; archived: boolean }; result: null };
  /** the Home agent's chats (Home's tabs, oldest first; absent from a runner from before tabs) and its current one (where watch reports go), the folder its chats run in, and what it runs on. `rev`: as in HomeChatUpdate */
  homeAgent: { args: Record<string, never>; result: { sessionId?: string; chats?: string[]; folder: string; rev: number; settings?: HomeAgentSettings; harnesses?: HarnessId[] } };
  /**
   * What the Home agent runs on, kept on the runner for every chat to come. The chat in view
   * (`sessionId`, an open tab; else the current one) takes it too: a model and a mode now, Claude's
   * source from its next start, and a harness or a Codex source by a move (a new chat with the
   * conversation, in the same tab). Answers with that chat as it is now
   */
  homeAgentSet: { args: HomeAgentSettings & { sessionId?: string }; result: { sessionId?: string; settings: HomeAgentSettings; rev: number } };
  /** a new Home agent chat, a new tab (the last) and current from now; its first send starts it */
  homeAgentNew: { args: Record<string, never>; result: { sessionId: string; rev: number } };
  /** `/new` or `/clear` on Home: no current chat, so the next message starts a fresh one. The old chat stops (if it runs) and stops following its sessions */
  homeAgentClear: { args: Record<string, never>; result: { rev: number } };
  /** closes a Home tab: that chat is archived (its history kept), stopped if it runs, and stops following its sessions */
  homeAgentClose: { args: { sessionId: string }; result: { rev: number } };
  /** "Watch all sessions": whether the Home agent hears when sessions it doesn't follow finish, fail or wait for the person (default on). No `on`: just answers. `following`: the sessions its chats follow (absent from a runner from before it was sent) */
  homeAgentWatch: { args: { on?: boolean }; result: { watchAll: boolean; following?: string[] } };
  /** "Reply by text": whether the Home agent's Texts tab answers the person's texts (and reports on work they texted for) by text (default on). No `on`: just answers */
  homeAgentReplyByText: { args: { on?: boolean }; result: { replyByText: boolean } };
  /**
   * "Archive done sessions" on Home: the Home agent's check-in (check_in_sessions) without a chat.
   * `start` begins one unless one is running; `dismiss` forgets the last result. Always answers with
   * where things stand: the check-in running now, and the last one's result
   */
  homeAgentCheckIn: { args: { start?: boolean; dismiss?: boolean }; result: CheckInStatus };
  runnerSettings: { args: Record<string, never>; result: RunnerSettings };
  /** changes the given settings; live sessions follow at once */
  setRunnerSettings: { args: RunnerSettings; result: RunnerSettings };
  /** Each harness's installed and newest version and how it was installed (cached a few minutes; `refresh` looks again). Updates in progress show on their rows */
  harnessVersions: { args: { refresh?: boolean }; result: HarnessReport };
  /** Starts updating one harness (one at a time per runner) and answers at once; poll harnessVersions for its output. Running sessions aren't stopped */
  harnessUpdate: { args: { id: string }; result: HarnessReport };
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
  /** the commands and skills a session has, from its harness (capabilities.commands) */
  listCommands: { args: { sessionId: string }; result: { commands: HarnessCommand[] } };
  /** where a session can move, and whether it can now (SPEC §15) */
  moveOptions: { args: { sessionId: string }; result: MoveOptions };
  /** moves a session to another harness: a new session there; the old one stays as it is */
  moveSession: { args: { sessionId: string; harness: string; model?: string; effort?: string; source?: BillingSource }; result: { sessionId: string } };

  // ---------- driving ----------

  /**
   * A new session in a folder (a path on the runner; `~` is the home folder). The harness starts
   * right away so a problem (not signed in, no such folder) shows before you type.
   */
  /**
   * With `terminal`, the session starts in the harness's own TUI (Claude: `--session-id`) instead of
   * through the SDK, in terminal mode (SPEC §8). With `createFolder` (the owner confirmed it), a
   * folder that doesn't exist is made first, parents too; without it the runner never makes one.
   */
  newSession: {
    args: { harness: HarnessId; projectPath: string; model?: string; effort?: string; permissionMode?: string; terminal?: boolean; createFolder?: boolean; source?: BillingSource };
    result: { sessionId: string };
  };
  /** What newSession would find at a path on the runner. Read-only. */
  checkFolder: { args: { projectPath: string }; result: FolderCheck };
  /** The folders inside a folder on the runner (Add project's folder browser). Read-only. */
  listFolders: { args: { path: string }; result: FolderList };
  /**
   * Add project: starts `git clone git@github.com:org/repo.git` into `path` (a new folder; parents
   * are made) and answers right away; `cloneStatus` tells how it goes. `repo` is `org/repo` or a
   * GitHub URL; it always clones over SSH. A folder that already holds a clone of that repo is
   * done at once; any other existing folder is refused here.
   */
  cloneRepo: { args: { repo: string; path: string }; result: { cloneId: string } };
  /** How a clone is going (polled; kept a while after it ends). */
  cloneStatus: { args: { cloneId: string }; result: CloneStatus };
  /** The clones still running (a New session dialog opened again picks one back up). */
  activeClones: { args: Record<string, never>; result: { clones: ActiveClone[] } };
  /** Stops a running clone; what it wrote is removed. */
  cancelClone: { args: { cloneId: string }; result: null };
  /**
   * Starts a turn; a stored session goes live first (SPEC §4). In terminal mode: typed into the TUI,
   * then Enter (SPEC §9). `stop`: Stop and send now (the running turn is stopped first). Sending
   * releases a queue held after Stop.
   */
  send: { args: { sessionId: string; text: string; attachments?: Attachment[]; stop?: boolean }; result: null };
  /**
   * A message into the running turn (capabilities.canSteer); on a subagent, into its own turn
   * (subagents.steer "direct"), or passed on by the main agent (subagents.steer "via-parent", SPEC
   * §6a). It can't be taken back once the harness has it.
   */
  steer: { args: { sessionId: string; text: string; attachments?: Attachment[] }; result: null };
  /**
   * Queues a message to go out after the running turn, one per turn (SPEC §9). On an idle session
   * whose queue isn't held, it goes out now.
   */
  queue: { args: { sessionId: string; text: string; attachments?: Attachment[] }; result: { id: string } };
  /** Changes a waiting message's text (its attachments stay). */
  editQueued: { args: { sessionId: string; id: string; text: string }; result: null };
  cancelQueued: { args: { sessionId: string; id: string }; result: null };
  /** Moves a waiting message to position `to` (0 goes next). */
  moveQueued: { args: { sessionId: string; id: string; to: number }; result: null };
  /** Releases a held queue: the next message goes out when the session is idle. */
  resumeQueue: { args: { sessionId: string }; result: null };
  /**
   * One chunk of a file attached to a message (SPEC §9). Chunks are ATTACH_CHUNK bytes (the last
   * shorter) at offsets that are multiples of it, base64; the answer to the chunk that completes the
   * file carries the stored attachment. A chunk sent again is harmless.
   */
  uploadAttachment: {
    args: { sessionId: string; uploadId: string; name: string; mimeType: string; size: number; offset: number; data: string };
    result: { attachment?: Attachment };
  };
  /** Marks a session read (it leaves Home's inbox on every device) or unread again. */
  setRead: { args: { sessionId: string; read: boolean }; result: null };
  /** This device wants notifications from this runner (SPEC §11 P5): kept until it unsubscribes. */
  pushSubscribe: { args: { deviceId: string; subscription: PushSubscriptionInfo; label?: string }; result: null };
  pushUnsubscribe: { args: { endpoint: string }; result: null };
  /** Whether this runner has the subscription. */
  pushStatus: { args: { endpoint: string }; result: { subscribed: boolean; ready: boolean } };
  /** Sends a test notification to one subscription. */
  pushTest: { args: { endpoint: string }; result: null };
  /** Texting (iMessage through Photon, SPEC §11 Texting): how it's set on this runner. Never the keys. */
  textingStatus: { args: {}; result: TextingStatus };
  /** Changes texting's settings; an empty string clears a field. The link restarts. */
  setTexting: { args: { enabled?: boolean; phone?: string; projectId?: string; projectSecret?: string }; result: TextingStatus };
  /** Sends a test text to the phone. */
  textingTest: { args: {}; result: null };
  /** What a short link's code (`#/l/<code>`, runner modules/links) opens on this runner (the browser takes the runner to be the one it asked); null: not one of its codes, or expired. */
  resolveLink: { args: { code: string }; result: { sessionId: string } | null };
  /** Messaging connectors (iMessage, Discord, …; SPEC §11 Texting): each one's settings and status. Never a secret. */
  messagingStatus: { args: {}; result: MessagingStatus };
  /** Changes one connector's settings (`values`: its forms' inputs; an empty string clears one) or turns it on or off. Its link restarts. */
  setConnector: { args: { id: string; enabled?: boolean; values?: Record<string, string> }; result: MessagingStatus };
  /** Where Tether's texts go: one connector, or (none) wherever the person last wrote. */
  setMessagingPrefer: { args: { prefer: string | null }; result: MessagingStatus };
  /** Sends a test message on one connector. */
  testConnector: { args: { id: string }; result: null };
  /**
   * A `!` command from the composer (SPEC §9 Shell commands): runs `command` now with `$SHELL -c` in
   * the session's folder, whatever the agent is doing. Its card (a message with `shell`, id `id`)
   * streams its output; when it ends, the command and its output go to the agent through the queue.
   */
  runShell: { args: { sessionId: string; command: string }; result: { id: string } };
  /** Stops a running `!` command (its whole process group); what it printed still goes, marked stopped. */
  stopShell: { args: { sessionId: string; id: string }; result: null };
  /** stops the running turn; on a subagent, stops that subagent */
  interrupt: { args: { sessionId: string }; result: null };
  /**
   * Moves a foreground subagent to the background (capabilities.subagents.background): `toolId` is
   * the call that started it, in `sessionId`'s transcript. Nothing happens if it isn't in the
   * foreground any more.
   */
  backgroundSubagent: { args: { sessionId: string; toolId: string }; result: null };
  /** Ends the commands in background terminals that run with more access than the session shows. */
  stopBackground: { args: { sessionId: string }; result: null };
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
  /**
   * Attaches this browser to a terminal (SPEC §8); the server fills in attachId. `sessionId`: the
   * session's TUI. A session not in the terminal yet is handed to it first (handoff harnesses: the
   * driver closes and the mode becomes terminal). While a turn runs that fails with TERMINAL_BUSY
   * unless `stop` is set: then the turn is stopped first. `shellId`: one of the project's shells.
   * `reattach`: only attach to a TUI that still runs (a browser coming back after a reconnect must
   * never start one again).
   */
  openTerminal: {
    args: { sessionId?: string; shellId?: string; attachId?: string; cols: number; rows: number; stop?: boolean; reattach?: boolean };
    result: { attachId: string; target: string };
  };
  /**
   * Back to Tether (SPEC §8): the TUI is asked to quit (killed after 5 s), and the session goes
   * live again on the same conversation. For a shared terminal: the TUI quits and Tether goes on
   * driving.
   */
  endTerminal: { args: { sessionId: string }; result: null };
  /** A project's plain shells (SPEC §8 Project shells), oldest first. */
  listShells: { args: { projectPath: string }; result: { shells: ShellInfo[] } };
  /** Opens a new shell in a project folder; attach to it with openTerminal({ shellId }). */
  newShell: { args: { projectPath: string; cols?: number; rows?: number }; result: ShellInfo };
  closeShell: { args: { shellId: string }; result: null };
  closeTerminal: { args: { attachId: string }; result: null };
  /** base64 bytes typed into an attached terminal */
  /** `leave`: out of copy mode first, whatever the keys (the runner tells otherwise by the bytes); `swipe`: wheel notches of one line each */
  terminalInput: { args: { attachId: string; data: string; leave?: boolean; swipe?: boolean }; result: null };
  terminalResize: { args: { attachId: string; cols: number; rows: number }; result: null };
  /**
   * An attached terminal's text, scrollback included (the panel's Copy), the newest
   * TERMINAL_TEXT_MAX bytes of it (`cut`: older lines left out). Only the attaching browser may ask.
   */
  terminalText: { args: { attachId: string }; result: { text: string; cut: boolean } };
}

/**
 * A path as the runner sees it. `missing`: newSession can make it with `createFolder`. `relative`:
 * not there, and too loose to make (it needs to start with `/` or `~/`). `error`: it can't be used.
 */
export interface FolderCheck {
  /** expanded */
  path: string;
  state: "exists" | "missing" | "relative" | "error";
  /** what's wrong, for `relative` and `error` */
  error?: string;
}

/** listFolders: the folders inside `path` (expanded), by name, dot folders left out. */
export interface FolderList {
  path: string;
  /** the folder above; none at / */
  parent?: string;
  folders: string[];
  /** more folders than were listed */
  more?: boolean;
}

/** activeClones: a running clone, with the repo as it was typed. */
export interface ActiveClone {
  cloneId: string;
  repo: string;
  status: CloneStatus;
}

/** cloneStatus: a clone's progress. */
export interface CloneStatus {
  state: "running" | "done" | "failed";
  /** the folder it clones into (expanded) */
  path: string;
  /** what git is doing now, e.g. "Receiving objects" */
  phase?: string;
  /** 0–100 over the whole clone; none while the server is still counting */
  percent?: number;
  /** how much came so far and how fast, e.g. "10.96 MiB · 1.55 MiB/s" */
  detail?: string;
  error?: string;
}

/** A browser's push subscription (PushSubscription.toJSON()). */
export interface PushSubscriptionInfo {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * The app's VAPID key pair (SPEC §11 P5), kept by the server (TETHER_VAPID_PUBLIC_KEY and
 * TETHER_VAPID_PRIVATE_KEY, base64url as web-push prints them) and handed to each runner on
 * connect, so every runner signs pushes with the same key and a device subscribes once.
 */
export interface PushKeys {
  publicKey: string;
  privateKey: string;
  /** the VAPID `sub` claim: the app's https URL, or a mailto: */
  subject: string;
}

/** What a notification carries to the service worker (web/public/sw.js). */
export interface PushPayload {
  kind: "request" | "finished" | "failed" | "test";
  title: string;
  body: string;
  runnerId: string;
  sessionId?: string;
  /** replaces an earlier notification with the same tag */
  tag?: string;
  ts: number;
}

/** A plain shell in a project folder, kept in tmux until closed. */
export interface ShellInfo {
  id: string;
  projectPath: string;
  /** its number in the project: "Shell 2" */
  n: number;
  /** what runs in it now ("bash", "python3") */
  command?: string;
}

/** openTerminal's error while a turn runs and `stop` isn't set: the UI asks first (SPEC §8). */
export const TERMINAL_BUSY = "A turn is running. Stop it to open the terminal.";
/** openTerminal's error for a terminal that is gone (a shell that exited, a TUI on reattach). */
export const TERMINAL_CLOSED = "That terminal has closed.";

export type OpName = keyof Ops;
export type OpArgs<K extends OpName> = Ops[K]["args"];
export type OpResult<K extends OpName> = Ops[K]["result"];

/** Ops the server reads (and partly answers) instead of passing through blind. */
export const TERMINAL_OPS = ["closeTerminal", "terminalInput", "terminalResize", "terminalText"] as const satisfies readonly OpName[];

/** terminalText answers at most this much (UTF-8 bytes): well inside a frame. */
export const TERMINAL_TEXT_MAX = 2 * 1024 * 1024;

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

/**
 * The Home agent's tabs or current chat changed (a new one, a closed one, the person wrote in another): broadcast to every
 * browser, so each device's Home shows the same tabs. `rev` grows with each change (it's kept across
 * restarts), so an answer to the `homeAgent` rpc and a broadcast can be put in order.
 */
export interface HomeChatUpdate {
  /** the current chat, where watch reports go; absent: no tab, the next message starts one */
  sessionId?: string;
  /** the open chats, Home's tabs (absent from a runner from before tabs) */
  chats?: string[];
  rev: number;
}

/** One session in a check-in's result, with why it was or wasn't archived (or asked). */
export interface CheckInRow {
  id: string;
  title: string;
  project: string;
  reason?: string;
}

/** Where the Home agent's check-ins stand (the homeAgentCheckIn op). */
export interface CheckInStatus {
  /** one running now: how many were asked and how many have been settled */
  running?: { id: string; at: number; deadline: number; asked: number; answered: number };
  /** the last one that finished (kept until dismissed or replaced) */
  last?: { id: string; at: number; archived: CheckInRow[]; kept: CheckInRow[]; skipped: CheckInRow[] };
}

// ---------- messages ----------

export interface ResultMsg {
  t: "result";
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export type BrowserToServer =
  | { t: "rpc"; id: string; runnerId: string; op: OpName; args: unknown }
  /**
   * What this device is looking at: a session while it is on screen (the page visible), else
   * nothing. Runners skip notifying a device about the session it looks at, and mark the session
   * read (SPEC §10 Home). `deviceId` is the device's own random id (also given to pushSubscribe).
   */
  | { t: "presence"; deviceId: string; runnerId?: string; sessionId?: string }
  | { t: "ping" };

export type ServerToBrowser =
  /** `push`: the public key to subscribe with; absent when the server has no push keys */
  | { t: "hello"; user: User; protocol: number; push?: { publicKey: string } }
  /** every connected runner, sent on connect and whenever the set changes */
  | { t: "runners"; runners: RunnerInfo[] }
  | ResultMsg
  | { t: "event"; runnerId: string; sessionId: string; seq: number; event: SessionEvent }
  | { t: "summary"; runnerId: string; summary: SummaryUpdate }
  | ({ t: "homeChat"; runnerId: string } & HomeChatUpdate)
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
  /** the hello was accepted: the runner is connected from here on. `push`: the app's VAPID keys */
  | { t: "welcome"; push?: PushKeys }
  /**
   * Which devices look at which of this runner's sessions right now (presence), all of it, sent on
   * connect and whenever it changes.
   */
  | { t: "viewers"; sessions: Record<string, string[]> }
  /** answers the runner's keepalive ping */
  | { t: "pong" };

export type RunnerToServer =
  | { t: "hello"; runner: Omit<RunnerInfo, "connectedAt"> }
  | ResultMsg
  | { t: "event"; sessionId: string; seq: number; event: SessionEvent }
  | { t: "summary"; summary: SummaryUpdate }
  | ({ t: "homeChat" } & HomeChatUpdate)
  | { t: "term"; attachId: string; data: string }
  | { t: "termEnd"; attachId: string; reason?: string }
  /** keepalive; the server answers pong, so a dead connection shows up as silence */
  | { t: "ping" };

/** One of a connector's settings forms: some inputs saved together. */
export interface ConnectorForm {
  key: string;
  label: string;
  /** what's set now, never a secret: "••••1234", "Set · from runner.env", "Not set" */
  status: string;
  /** set in runner.env: read-only here */
  fromEnv?: boolean;
  inputs: { key: string; placeholder: string; secret?: boolean; type?: "text" | "tel"; optional?: boolean }[];
  /** it can be cleared (an Unset button) */
  unset?: boolean;
  /** a line under it */
  note?: string;
}

/** A messaging connector on a runner, as the web sees it (secrets stay on the runner). */
export interface ConnectorStatus {
  id: string;
  label: string;
  enabled: boolean;
  /** everything it needs is set */
  configured: boolean;
  connected: boolean;
  lastError?: string;
  about: string;
  forms: ConnectorForm[];
}

export interface MessagingStatus {
  connectors: ConnectorStatus[];
  /** the connector Tether's texts go to; unset: the one the person last wrote on */
  prefer?: string;
  /** the one the person last wrote on */
  lastUsed?: string;
}

/** Texting's settings on a runner, as the web sees them (secrets stay on the runner). */
export interface TextingStatus {
  enabled: boolean;
  /** the phone's last 4 digits */
  phoneLast4?: string;
  /** the Photon project's id and secret are both set */
  keysSet: boolean;
  /** what holds a field: the runner's environment (runner.env) wins over what was saved here */
  fromEnv: { phone: boolean; keys: boolean };
  connected: boolean;
  lastError?: string;
}
