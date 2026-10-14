// Sessions that aren't running. Opening one shows its stored conversation (the adapter's
// storedHistory) with the settings Tether keeps for it (config().sessions, see LiveSession.savePrefs),
// without starting the agent; the agent starts only when something needs it (a message, a plan
// action…). Settings changed meanwhile are saved here and applied when it starts (getLive →
// reapplyChoices / loadPrefs).

import type { DiffStat, HarnessId, LiveState, SessionSnapshot, SessionSummary } from "../../web/src/shared/protocol";
import type { PlanReviewState } from "../../web/src/shared/plan";
import { emptyState } from "../../web/src/shared/reducer";
import { bySoonest } from "../../web/src/shared/schedule";
import { subagentItem } from "../../web/src/shared/subagents";
import type { StoredHistory } from "./adapters/types";
import type { SessionPrefs } from "./config";
import { switchModel } from "./contextWindow";
import { pickEntry, profile } from "./fallback";
import type { GuardMode } from "./guard";
import { tagToolParts } from "./toolKind";

/** The state a session that isn't running shows: idle, nothing running, its saved settings. */
export function storedState(o: {
  prefs?: SessionPrefs;
  history: Omit<StoredHistory, "messages">;
  /** the harness's fixed modes (Adapter.modes), when it never reported its own here */
  modes?: string[];
  plans?: Record<string, PlanReviewState>;
  defaultGuard: GuardMode;
  diffStat?: DiffStat;
}): LiveState {
  const p = o.prefs ?? {};
  const h = o.history;
  const model = p.model ?? h.model;
  const context = p.context ?? h.context;
  const state: LiveState = {
    ...emptyState(),
    status: "idle",
    model,
    thinking: p.thinking ?? h.thinking,
    permissionMode: p.permissionMode ?? h.permissionMode,
    modes: p.modes ?? o.modes,
    thinkingLevels: p.thinkingLevels,
    chain: p.chain,
    profile: p.profile,
    preferEarlier: p.preferEarlier ?? true,
    handoffFrom: p.handoffFrom,
    handoffTo: p.handoffTo,
    guard: p.guard ?? o.defaultGuard,
    checkpoints: p.checkpoints,
    // Messages it hadn't taken when it stopped: held, they go out when you send (which starts it).
    pending: p.pending?.length ? p.pending : undefined,
    pendingHeld: p.pending?.length ? true : undefined,
    diffStat: o.diffStat,
    // The model may have been changed since: the same conversation in that model's window.
    context: context && model && model !== "default" ? switchModel(context, model) : context,
    // Its subagents are sessions of their own: they show (and may still run) while it's stopped.
    activity: p.subagents?.length && !p.handoffTo ? p.subagents.map((l) => subagentItem(l)) : [],
    plans: o.plans ?? {},
    ...storedExtras(p),
  };
  for (const k of Object.keys(state) as (keyof LiveState)[]) if (state[k] === undefined) delete state[k];
  return state;
}

/**
 * Tether's own per-session state (goal, plan and todos, loops and schedules, reviews, fork and
 * review links), as LiveSession.loadPrefs brings it back when the session starts: an active goal
 * nothing drives shows paused, an open plan review as a draft, a review that never started failed.
 */
export function storedExtras(p: SessionPrefs): Partial<LiveState> {
  const out: Partial<LiveState> = {};
  if (p.forkedFrom) out.forkedFrom = p.forkedFrom;
  let goal = p.goal;
  if (goal?.status === "active" && (!p.active || p.handoffTo)) {
    const reason = p.handoffTo ? "Continued in another session." : "Paused when the runner restarted.";
    goal = { ...goal, status: "paused", reason };
  }
  if (goal) out.goal = goal;
  if (p.plan) out.plan = p.plan.status === "review" ? { ...p.plan, status: "draft" } : p.plan;
  // Loops and schedules handed off went with the conversation; the rest still run (the scheduler starts it).
  if (p.schedules?.length && !p.handoffTo) out.schedules = [...p.schedules].sort(bySoonest);
  if (p.reviews?.length)
    out.reviews = p.reviews.map((r) => (r.status === "starting" ? { ...r, status: "failed" as const, error: "The runner restarted before the review started." } : r));
  if (p.reviewOf) out.reviewOf = p.reviewOf;
  // Cross-harness subagents: who started it, and the ones it started (handed off: they went along).
  if (p.startedBy) out.startedBy = p.startedBy;
  if (p.subagents?.length && !p.handoffTo) out.subagents = p.subagents;
  return out;
}

export function storedSnapshot(session: SessionSummary, history: StoredHistory, state: LiveState, seq: number): SessionSnapshot {
  return { session: { ...session, live: false, status: "idle", needsInput: false }, messages: history.messages, state, seq };
}

/** A setting changed while the session isn't running. */
export type StoredSetting =
  | { op: "model"; model?: string; profile?: string }
  | { op: "chain"; chain: string[]; preferEarlier?: boolean }
  | { op: "thinking"; level: string }
  | { op: "mode"; mode: string }
  | { op: "guard"; mode: GuardMode };

/** The current model a chain starts on, when its first available entry is in this harness (as LiveSession.setChain). */
function chainModel(chain: string[], harness: HarnessId): { model?: string } {
  const pick = pickEntry(chain, harness);
  return "entry" in pick && pick.entry.harness === harness ? { model: pick.entry.model } : {};
}

/**
 * What a setting changes, as LiveSession would change it (setModelOrProfile, setChain, …). The
 * keys are the same in LiveState and SessionPrefs, so this is both the state event browsers get
 * and what is saved.
 */
export function settingChange(harness: HarnessId, s: StoredSetting): Partial<LiveState> {
  switch (s.op) {
    case "model": {
      if (s.profile) {
        const p = profile(s.profile);
        if (!p) throw new Error(`No model profile "${s.profile}"`);
        return { chain: [...p.chain], profile: p.name, ...chainModel(p.chain, harness) };
      }
      return s.model ? { profile: undefined, chain: undefined, model: s.model } : {};
    }
    case "chain":
      return { chain: s.chain, profile: undefined, ...(s.preferEarlier !== undefined ? { preferEarlier: s.preferEarlier } : {}), ...chainModel(s.chain, harness) };
    case "thinking":
      return { thinking: s.level };
    case "mode":
      return { permissionMode: s.mode };
    case "guard":
      return { guard: s.mode };
  }
}

/**
 * Bookkeeping for sessions that aren't running: their stored conversations (read once per
 * version: a session's updatedAt moves with every new message), where they are, and their event
 * numbers. A browser keeps counting a session's events across its process stopping and starting
 * again, so a new process goes on from the last number (getLive), and so do changes made meanwhile.
 */
export class StoredSessions {
  static MAX_CACHED = 20;
  private seqs = new Map<string, number>();
  private paths = new Map<string, string>();
  private cache = new Map<string, { version: string; load: Promise<StoredHistory | undefined> }>();

  /**
   * `stamp`: what else tells versions apart (a transcript file's size and time), for harnesses
   * whose updatedAt doesn't move with every change to their store.
   */
  constructor(
    private read: (s: SessionSummary) => Promise<StoredHistory | undefined>,
    private stamp: (s: SessionSummary) => Promise<string | undefined> = async () => undefined,
  ) {}

  /** An event with this number went out for the session (running or not): later ones go on from it. */
  saw(id: string, seq: number) {
    if (seq > this.seq(id)) this.seqs.set(id, seq);
  }

  /** The session's last event number. */
  seq(id: string): number {
    return this.seqs.get(id) ?? 0;
  }

  /** The next event number, for a change made while it isn't running. */
  nextSeq(id: string): number {
    const n = this.seq(id) + 1;
    this.seqs.set(id, n);
    return n;
  }

  /** Its process stopped at event `seq`; the conversation has changed since it was read. */
  closed(id: string, seq: number, projectPath?: string) {
    this.seqs.set(id, Math.max(seq, this.seq(id)));
    if (projectPath) this.paths.set(id, projectPath);
    this.cache.delete(id);
  }

  path(id: string): string | undefined {
    return this.paths.get(id);
  }

  /** The stored conversation, read once per version; undefined when only a running agent can show it. */
  async history(s: SessionSummary): Promise<StoredHistory | undefined> {
    this.paths.set(s.id, s.projectPath);
    const version = `${s.updatedAt}:${(await this.stamp(s).catch(() => undefined)) ?? ""}`;
    const hit = this.cache.get(s.id);
    if (hit && hit.version === version) {
      this.cache.delete(s.id);
      this.cache.set(s.id, hit);
      return hit.load;
    }
    const load = this.read(s).then((h) => {
      if (h) tagToolParts(h.messages); // as LiveSession.emit tags a replay
      return h;
    });
    const entry = { version, load };
    this.cache.delete(s.id);
    this.cache.set(s.id, entry);
    while (this.cache.size > StoredSessions.MAX_CACHED) this.cache.delete(this.cache.keys().next().value!);
    // A failed read is tried again next time.
    load.then(
      (h) => !h && this.cache.get(s.id) === entry && this.cache.delete(s.id),
      () => this.cache.get(s.id) === entry && this.cache.delete(s.id),
    );
    return load;
  }

  forget(id: string) {
    this.cache.delete(id);
    this.paths.delete(id);
  }
}
