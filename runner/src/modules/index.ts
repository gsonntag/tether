// Modules: features outside the session core (notifications, checkpoints, the judge, …). Each one
// subscribes to core events and registers ops through the narrow context it's given; the core
// never imports a module (SPEC §2, §3).

import type { EventBus } from "../core/bus";
import type { CoreEvents } from "../core/events";
import type { OpRegistry } from "../core/ops";
import type { Adapter, StartOpts } from "../core/adapter";
import type { BillingSource, CredentialSource, SourceChoices } from "../../../shared/credentials";
import type { HomeChatUpdate } from "../../../shared/protocol";
import type { ForkedFrom } from "../../../shared/fork";
import type { Attachment } from "../../../shared/attachments";
import type { SessionCost } from "../../../shared/costs";
import type { HarnessId, LiveState, Msg, ProjectInfo, RequestAnswer, RunStatus, SessionSummary } from "../../../shared/transcript";
import { filesModule } from "./files";
import { gitModule } from "./git";
import { homeAgentModule } from "./homeAgent";
import type { HomeLine } from "./homeLine";
import type { HubPort } from "../core/hubPort";
import type { WorktreeRecord } from "../config";
import type { SetupRun } from "../core/shellRuns";
import { linksModule } from "./links";
import type { ShortLinks } from "./links/store";
import { forkModule } from "./fork";
import { moveModule } from "./move";
import { peersModule } from "./peers";
import { pushModule } from "./push";
import { sideChatsModule } from "./sideChats";
import { textingModule } from "./texting";
import { updatesModule } from "./updates";
import { worktreesModule } from "./worktrees";
import { usageModule } from "./usage";

/** What a module may know about a session (read-only). */
export interface SessionLook {
  summary: SessionSummary;
  status: RunStatus;
  /** ids of its open requests */
  requests: string[];
  /** the rest of what it's doing and how it's set, for a module that acts on a session */
  state: LiveState;
  /** work outside its turn: `!` commands, a starting or sending harness, a running subagent */
  busy: boolean;
  /** work the harness keeps running after its turn (shells, background subagents) */
  background: boolean;
}

/** More about a session being adopted. `stored`: it isn't started, its first send does that (a fork). */
export interface AdoptExtra {
  stored?: boolean;
  forkedFrom?: ForkedFrom;
  /** a side chat (SPEC §16a): the session it's beside */
  sideOf?: string;
  /** a fork's: the original's key preferences (the switch itself is ticked per session, so it isn't carried) */
  keys?: { lastKey?: BillingSource; fallbackKeys?: CredentialSource[] };
}

/** How to fork: the reply its conversation ends at (shared/fork.ts forkPoints); absent, all of it (the last finished turn while one runs). */
export interface ForkOptions {
  messageId?: string;
  /** the fork's permission mode instead of the original's (a side chat's read-only one) */
  permissionMode?: string;
  /** its title instead of "<title> (fork)" */
  title?: string;
  /** a side chat (SPEC §16a): beside the original, left out of the lists */
  sideOf?: string;
}

/** What a module may do with sessions, through the core's own paths (SPEC §2.1). */
export interface SessionActions {
  adapters(): Adapter[];
  /** a session, brought into memory if it's stored; throws when there's none */
  open(id: string): Promise<SessionLook>;
  /** a session whose store exists (a harness took a history): its settings, and it starts now, so its source is confirmed and shown before anything is typed. `from`: it's for that session's source change, unlisted, and a failed start throws */
  adopt(harness: HarnessId, nativeId: string, projectPath: string, opts: StartOpts, source: BillingSource, from?: string, extra?: AdoptExtra): Promise<string>;
  /** what makes the thread a session's source change goes to (Mover.carry) */
  carrier(make: (id: string, source: BillingSource) => Promise<string>): void;
  /** a fork of a session (SPEC §16): a new stored session with its conversation, through `messageId` when given. Its id */
  fork(id: string, o?: ForkOptions): Promise<string>;
  /** a session went on under another id (a Move): its side chats (SPEC §16a) are beside that one now */
  moveSides?(from: string, to: string): void;
  /** what makes forks (the fork module) */
  forker(make: (id: string, o: ForkOptions) => Promise<string>): void;
  /** a new session; its first send starts it */
  create(args: { harness: HarnessId; projectPath: string; source: BillingSource } & StartOpts): Promise<string>;
  /** a new native id, on that source */
  newId(harness: HarnessId, projectPath: string, opts: StartOpts, source: BillingSource): Promise<string>;
  /** the sources that exist for a harness now */
  sources(harness: HarnessId): Promise<SourceChoices>;
  /** what a session draws from */
  sourceOf(id: string): Promise<BillingSource>;
  /** the source a new session gets from what was asked for, remembered as that harness's choice */
  sourceForNew(harness: HarnessId, source: unknown): Promise<BillingSource>;
  /** a message from Tether, sent as a turn */
  send(id: string, text: string): Promise<void>;
  /** the person's own words (and files, stored under attachmentsDir), as if typed in the composer: into the running turn when it takes that, else sent */
  tell(id: string, text: string, attachments?: Attachment[]): Promise<void>;
  /** the person answers an open request (as the answerRequest op does) */
  answer(id: string, requestId: string, a: RequestAnswer): Promise<void>;
  /** a Tether notice, kept with the session */
  notice(id: string, msg: Msg, where?: { first?: boolean; after?: string }): Promise<void>;
  /** the folders with sessions (the lists' projects), newest activity first */
  projects(): Promise<ProjectInfo[]>;
  /** the sessions the lists show (recent ones and every live one, core/summaries.ts), newest activity first; not old ones listed only because they're pinned */
  list(): SessionSummary[];
  /** the archived sessions (which the lists leave out), newest activity first */
  archived(): Promise<SessionSummary[]>;
  /** every stored session of any age, archived ones too (marked), newest activity first; no subagents or side chats */
  all?(): Promise<SessionSummary[]>;
  /** the file its harness keeps a session's transcript in, when there's one (search reads it raw) */
  storeFile?(id: string, projectPath: string): Promise<string | undefined>;
  /** an existing folder for a new session, expanded; throws when there's none */
  folder(path: string): string;
  /** a message through the session's queue: now when it's idle, else after its turn (its id: the queueGone event says when it leaves) */
  queue(id: string, text: string, attachments?: Attachment[]): Promise<{ id: string }>;
  /** moves what waits in one session's queue (scheduled messages too) to another (a moved session's successor) */
  handOverQueue(from: string, to: string): Promise<void>;
  /** the newest `limit` messages of its transcript */
  recent(id: string, limit: number): Promise<Msg[]>;
  rename(id: string, title: string): Promise<void>;
  /** stops its running turn */
  interrupt(id: string): Promise<void>;
  /** keeps a session out of Recent (or puts it back), as the archive button does */
  setArchived(id: string, archived: boolean): Promise<void>;
  /** a one-shot side query on the session's harness and source (Adapter.ask): never a turn, nothing in its transcript. Rejects when its harness can't, or its source can't be confirmed */
  ask?(id: string, prompt: string, opts: { system: string; timeoutMs: number }): Promise<string>;
  /** holds every main session whose folder is in `folder` (stored ones, and any made there meanwhile, too), as `hold` */
  holdFolder?(folder: string, why: string): () => void;
  /** why a session is held (a restore in its repo), when it is */
  heldWhy?(id: string): string | undefined;
  /** records the worktree a session works in (made for it, or joined) as its own (runner.json; the summary's worktreeOf) */
  setWorktree?(id: string, worktree: WorktreeRecord): Promise<void>;
  /** the worktree a session works in, if Tether recorded one */
  worktree?(id: string): WorktreeRecord | undefined;
  /** every session (of any age, not moved on to another id) recorded as working in the worktree at `path` (any worktree without it), archived ones marked */
  worktreeUsers?(path?: string): { id: string; worktree: WorktreeRecord; archived?: boolean }[];
  /**
   * Runs a new worktree's setup in the session's folder as a card (core/shellRuns.ts): until it
   * ends, sends wait held; a failure keeps them held. Answers once it has started.
   */
  setup?(id: string, command: string, run?: Omit<SetupRun, "done"> & { beforeRelease?: () => void | Promise<void> }): Promise<{ done: Promise<{ ok: boolean; why: string }> }>;
}

export interface ModuleContext {
  bus: EventBus<CoreEvents>;
  ops: OpRegistry;
  /** this module's own directory under the runner's config dir */
  dataDir: string;
  log: (line: string) => void;
  runnerId: string;
  /** a session the runner has in memory */
  session(id: string): SessionLook | undefined;
  /** every session the runner has in memory (a session that's running anything is) */
  loaded?(): SessionLook[];
  /** acting on sessions */
  sessions: SessionActions;
  /** devices looking at a session (or one of its subagents) right now */
  viewersOf(id: string): string[];
  /** the app's URL (TETHER_URL) */
  appUrl: string;
  /** where attachments are kept (CONFIG_DIR/attachments) */
  attachmentsDir?: string;
  /** the Home agent's folder (RunnerOptions.homeFolder); its sessions are left out of the lists */
  homeFolder?: string;
  /** what Tether's API cost ledger holds for a session (undefined: no entry) */
  apiCost?(sessionId: string): SessionCost | undefined;
  /** a folder the lists hide (TETHER_HIDE_PROJECTS, the Home agent's) */
  hiddenFolder?(path: string): boolean;
  /** tells every browser the Home agent's current chat changed (dropped while disconnected: browsers ask again on reconnect) */
  announceHomeChat?: (u: HomeChatUpdate) => void;
  /** texting ↔ the Home agent (homeLine.ts): one for the whole runner */
  homeLine?: HomeLine;
  /** short links to sessions (links/store.ts): one for the whole runner */
  links?: ShortLinks;
  /** the texting hub's wire (core/hubPort.ts): who texts for this runner, and frames to and from it */
  hub?: HubPort;
}

export interface Module {
  name: string;
  /** May return a stop function, called on shutdown. */
  start(ctx: ModuleContext): void | (() => void) | Promise<void | (() => void)>;
}

/** The modules this runner loads, in order. */
export const MODULES: Module[] = [pushModule, textingModule, moveModule, forkModule, sideChatsModule, worktreesModule, homeAgentModule, peersModule, updatesModule, linksModule, usageModule, gitModule, filesModule];

export async function startModules(modules: Module[], ctx: (m: Module) => ModuleContext): Promise<() => void> {
  const stops: (() => void)[] = [];
  for (const m of modules) {
    try {
      const stop = await m.start(ctx(m));
      if (stop) stops.push(stop);
    } catch (e) {
      // A broken module must not take the runner down with it.
      console.error(`module ${m.name} failed to start:`, e);
    }
  }
  return () => stops.reverse().forEach((s) => s());
}
