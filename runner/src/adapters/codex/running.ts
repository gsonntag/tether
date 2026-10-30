// What runs on a Codex thread right now, each with the settings it really runs with: the main
// turn, and each subagent (a thread of its own, which keeps the settings it started with even after
// the turn that spawned it ends). The settings come from the daemon: what Tether pinned on a turn it
// started (turn/start carries them), a turn's turn_context in the rollout, or the thread's settings
// as the daemon reports them; never inferred from what Tether shows. Unknown counts as looser than
// anything (fail closed).
//
// The header rule (LiveState.turnSettings): if anything here differs from the settings shown, the
// header says what it runs with instead, and offers Stop when it has more access. Turns starting or
// ending elsewhere never clear another entry: each clears only when its own thing ends.

import type { LiveState } from "../../../../shared/transcript";
import { looser, modeOf, sandboxOf } from "./modes";
import type { RolloutSettings } from "./discovery";

/** Effective settings. `mode` undefined: not known (shown as Unknown, counted as looser). */
export interface Eff {
  model?: string;
  effort?: string;
  approvalPolicy?: string;
  sandbox?: string;
  reviewer?: string;
  mode?: string;
}

/** From the daemon's thread settings (thread/settings/updated, thread/start, thread/resume). */
export function effOfSettings(s: any): Eff {
  return {
    ...(typeof s?.model === "string" ? { model: s.model } : {}),
    ...(typeof s?.effort === "string" ? { effort: s.effort } : {}),
    ...(typeof s?.approvalPolicy === "string" ? { approvalPolicy: s.approvalPolicy } : {}),
    ...(sandboxOf(s?.sandboxPolicy) ? { sandbox: sandboxOf(s.sandboxPolicy) } : {}),
    ...(typeof s?.approvalsReviewer === "string" ? { reviewer: s.approvalsReviewer } : {}),
    ...(modeOf(s?.approvalPolicy, s?.sandboxPolicy, s?.approvalsReviewer) ? { mode: modeOf(s.approvalPolicy, s.sandboxPolicy, s.approvalsReviewer) } : {}),
  };
}

/** From a turn's turn_context. */
export function effOfRollout(r: RolloutSettings): Eff {
  const { found: _f, at: _a, ...rest } = r;
  return rest;
}

/** Nothing known about it (fail closed). */
export const UNKNOWN: Eff = {};

type Kind = "turn" | "subagent";

export class Running {
  private entries = new Map<string, { kind: Kind; eff: Eff }>();

  set(id: string, kind: Kind, eff: Eff) {
    this.entries.set(id, { kind, eff });
  }

  delete(id: string) {
    this.entries.delete(id);
  }

  has(id: string) {
    return this.entries.has(id);
  }

  get(id: string) {
    return this.entries.get(id);
  }

  ids(kind?: Kind): string[] {
    return [...this.entries].filter(([, e]) => !kind || e.kind === kind).map(([id]) => id);
  }

  get size() {
    return this.entries.size;
  }

  /**
   * What the header says beside the shown settings (`current`): the first thing running looser than
   * shown (the main turn before subagents), else the first that just differs. Undefined: everything
   * running runs as shown.
   */
  report(current: Eff): LiveState["turnSettings"] {
    let differs: LiveState["turnSettings"];
    const sorted = [...this.entries.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "turn" ? -1 : 1));
    for (const { kind, eff } of sorted) {
      const out: NonNullable<LiveState["turnSettings"]> = {};
      if (eff.model && current.model && eff.model !== current.model) out.model = eff.model;
      if (eff.effort && current.effort && eff.effort !== current.effort) out.effort = eff.effort;
      const mode = eff.mode ?? "unknown";
      if (mode !== (current.mode ?? "unknown")) out.permissionMode = mode;
      const isLooser = !eff.mode || (out.permissionMode !== undefined && looser(eff, current));
      if (!Object.keys(out).length) continue;
      const r = { ...out, ...(isLooser ? { looser: true } : {}), who: kind };
      if (isLooser) return r;
      differs ??= r;
    }
    return differs;
  }
}
