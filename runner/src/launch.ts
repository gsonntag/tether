// Starting a new session: the one path for the New session dialog (index.ts createSession) and the
// leader's session_create (leader.ts), so a session the leader starts is set up exactly like one the
// user starts by hand (guard, permission mode, hooks, tracking, the lists). Kept out of index.ts,
// which connects on import, so tests can run it with stub harnesses.

import { resolve } from "node:path";
import type { CreatedBy, GuardMode, HarnessId } from "../../web/src/shared/protocol";
import { APPROVING_MODES } from "../../web/src/shared/protocol";
import type { Adapter, Sink } from "./adapters/types";
import { config, saveConfig } from "./config";
import { untilde } from "./context/paths";
import type { LiveSession } from "./session";

export interface LaunchDeps {
  adapters: Record<HarnessId, Adapter>;
  sink: Sink;
  track: (s: LiveSession) => LiveSession;
}

/** createSession's arguments (protocol.ts). */
export interface LaunchArgs {
  projectPath: string;
  harness: HarnessId;
  model?: string;
  profile?: string;
  prompt?: string;
  permissionMode?: string;
  guard?: GuardMode;
}

/** What only the runner sets (never a browser): its title, and who started it. */
export interface LaunchExtra {
  title?: string;
  createdBy?: CreatedBy;
}

/** A path as typed: `~` is $HOME, like every context path (context/paths.ts). */
export const expandPath = (p: string) => resolve(untilde(p));

/** The runner's guard for a new session when none is picked. */
export const defaultGuard = (): GuardMode => config().guard?.defaultMode ?? "auto";

export async function launchSession(d: LaunchDeps, { projectPath, harness, model, profile, prompt, permissionMode, guard }: LaunchArgs, extra: LaunchExtra = {}): Promise<LiveSession> {
  const a = d.adapters[harness];
  if (!a) throw new Error(`unknown harness ${harness}`);
  // Modes that approve tool calls by themselves (bypassPermissions…) never: the guard decides.
  const s = a.create(expandPath(projectPath), { model: profile ? undefined : model, permissionMode: permissionMode && !APPROVING_MODES.has(permissionMode) ? permissionMode : undefined }, d.sink);
  // Set before start() so harnesses that take it as a launch flag (Antigravity) see it.
  s.t.state.guard = guard ?? defaultGuard();
  if (extra.createdBy) s.t.state.createdBy = extra.createdBy;
  await s.start();
  d.track(s);
  s.setState({ guard: s.t.state.guard, ...(extra.createdBy ? { createdBy: extra.createdBy } : {}) });
  if (profile) await s.setModelOrProfile(undefined, profile);
  const title = extra.title?.replace(/\s+/g, " ").trim().slice(0, 200);
  if (title) {
    config().titles[s.id] = title;
    saveConfig();
    await s.rename(title).catch(() => s.setTitle(title));
  }
  if (prompt) await s.prompt(prompt);
  d.sink.summary(s.summary());
  return s;
}
