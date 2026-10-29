// Modules: features outside the session core (notifications, checkpoints, the judge, …). Each one
// subscribes to core events and registers ops through the narrow context it's given; the core
// never imports a module (SPEC §2, §3).

import type { EventBus } from "../core/bus";
import type { CoreEvents } from "../core/events";
import type { OpRegistry } from "../core/ops";
import type { RunStatus, SessionSummary } from "../../../shared/transcript";
import { pushModule } from "./push";

/** What a module may know about a session (read-only). */
export interface SessionLook {
  summary: SessionSummary;
  status: RunStatus;
  /** ids of its open requests */
  requests: string[];
  /** the start of the last thing the agent said, when the transcript is loaded */
  lastText?: string;
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
  /** devices looking at a session (or one of its subagents) right now */
  viewersOf(id: string): string[];
  /** the app's URL (TETHER_URL) */
  appUrl: string;
}

export interface Module {
  name: string;
  /** May return a stop function, called on shutdown. */
  start(ctx: ModuleContext): void | (() => void) | Promise<void | (() => void)>;
}

/** The modules this runner loads, in order. */
export const MODULES: Module[] = [pushModule];

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
