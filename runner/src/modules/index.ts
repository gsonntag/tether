// Modules: features outside the session core (notifications, checkpoints, the judge, …). Each one
// subscribes to core events and registers ops through the narrow context it's given; the core
// never imports a module (SPEC §2, §3).

import type { EventBus } from "../core/bus";
import type { CoreEvents } from "../core/events";
import type { OpRegistry } from "../core/ops";
import type { Adapter, StartOpts } from "../core/adapter";
import type { BillingSource, SourceChoices } from "../../../shared/credentials";
import type { HomeChatUpdate } from "../../../shared/protocol";
import type { HarnessId, LiveState, Msg, ProjectInfo, RequestAnswer, RunStatus, SessionSummary } from "../../../shared/transcript";
import { homeAgentModule } from "./homeAgent";
import { moveModule } from "./move";
import { pushModule } from "./push";
import { textingModule } from "./texting";

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

/** What a module may do with sessions, through the core's own paths (SPEC §2.1). */
export interface SessionActions {
  adapters(): Adapter[];
  /** a session, brought into memory if it's stored; throws when there's none */
  open(id: string): Promise<SessionLook>;
  /** a session whose store exists (a harness took a history): its settings, and it starts now, so its source is confirmed and shown before anything is typed. `from`: it's for that session's source change, unlisted, and a failed start throws */
  adopt(harness: HarnessId, nativeId: string, projectPath: string, opts: StartOpts, source: BillingSource, from?: string): Promise<string>;
  /** what makes the thread a session's source change goes to (Mover.carry) */
  carrier(make: (id: string, source: BillingSource) => Promise<string>): void;
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
  /** the person's own words, as if typed in the composer: into the running turn when it takes that, else sent */
  tell(id: string, text: string): Promise<void>;
  /** the person answers an open request (as the answerRequest op does) */
  answer(id: string, requestId: string, a: RequestAnswer): Promise<void>;
  /** a Tether notice, kept with the session */
  notice(id: string, msg: Msg, where?: { first?: boolean; after?: string }): Promise<void>;
  /** the folders with sessions (the lists' projects), newest activity first */
  projects(): Promise<ProjectInfo[]>;
  /** the sessions the lists show (recent ones and every live one, core/summaries.ts), newest activity first */
  list(): SessionSummary[];
  /** an existing folder for a new session, expanded; throws when there's none */
  folder(path: string): string;
  /** a message from Tether through the session's queue: now when it's idle, else after its turn */
  queue(id: string, text: string): Promise<void>;
  /** the newest `limit` messages of its transcript */
  recent(id: string, limit: number): Promise<Msg[]>;
  rename(id: string, title: string): Promise<void>;
  /** stops its running turn */
  interrupt(id: string): Promise<void>;
  /** keeps a session out of Recent (or puts it back), as the archive button does */
  setArchived(id: string, archived: boolean): Promise<void>;
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
  /** tells every browser the Home agent's current chat changed (dropped while disconnected: browsers ask again on reconnect) */
  announceHomeChat?: (u: HomeChatUpdate) => void;
}

export interface Module {
  name: string;
  /** May return a stop function, called on shutdown. */
  start(ctx: ModuleContext): void | (() => void) | Promise<void | (() => void)>;
}

/** The modules this runner loads, in order. */
export const MODULES: Module[] = [pushModule, textingModule, moveModule, homeAgentModule];

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
