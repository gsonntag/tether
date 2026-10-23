import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { DEFAULT_UI_PREFS, formatEntry, HARNESSES, parseEntry, SIDEBAR_DAYS, type UiPrefs } from "../../web/src/shared/protocol";
import { userHome } from "./home";

// $HOME first (as context/paths.ts does), so a runner launched with a scratch HOME never falls
// back to the account's real home through the password database.
export const CONFIG_DIR = process.env.TETHER_CONFIG_DIR ?? join(userHome(), ".config", "tether");
const CONFIG_FILE = join(CONFIG_DIR, "runner.json");

export interface RunnerConfig {
  runnerId: string;
  /** Projects added by hand (projects with sessions are discovered). */
  projects: string[];
  /** Projects hidden from the list. */
  hidden: string[];
  /** Session ids archived (hidden from the sidebar, nothing deleted). */
  archived: string[];
  /** Titles set by the user; they win over titles from the harness. */
  titles: Record<string, string>;
  /**
   * The user's default order (defaultOrder.ts): chain entries, first one first. New sessions,
   * cross-harness subagents started without a harness or model, and "Use the default order" copy
   * it into the session's own chain. Unset until the user saves one.
   */
  defaultOrder?: string[];
  /** provider key -> epoch ms until which it is considered out of quota */
  exhausted: Record<string, number>;
  /** per-session settings that must survive runner restarts */
  sessions: Record<string, SessionPrefs>;
  guard?: {
    /** the Auto-mode judge; on unless false. It runs on `backgroundModel`. */
    judge?: boolean;
    /**
     * Legacy: older versions kept the judge's Claude model here ("haiku", sometimes "harness:model",
     * or "off"). Migrated into `backgroundModel` / `judge` on load; only "off" is still written, so
     * an older runner reading this config keeps the judge off.
     */
    judgeModel?: string;
    defaultMode?: import("./guard").GuardMode;
  };
  /** "harness:model" for the judge and the memory merge (runner/src/context/background.ts) */
  backgroundModel?: string;
  /** master context: off until the first import is run from the UI. `handoffCapture: false` skips
   *  the fact capture before a cross-harness handoff (memory is still carried). */
  context?: { enabled?: boolean; importedAt?: number; handoffCapture?: boolean };
  /** web app preferences shared by every device (getUiPrefs / setUiPrefs) */
  ui?: Partial<UiPrefs>;
  /** "Always allow" on approvals, remembered per project (guard.ts matchRule) */
  approvals?: import("../../web/src/shared/protocol").ApprovalRule[];
  /** the owner's verdicts on judged calls, per project path, the last 20 (guard.ts recordPrecedent) */
  precedents?: Record<string, import("./guard").Precedent[]>;
  /** Web Push: this runner's VAPID key, subscribed devices, recent notifications */
  push?: { vapid?: { publicKey: string; privateKey: string }; subs: import("./notify").PushSub[]; recent: import("../../web/src/shared/protocol").AgentNotice[] };
}

export interface SessionPrefs {
  chain?: string[];
  preferEarlier?: boolean;
  handoffFrom?: { sessionId: string; reason: string };
  handoffTo?: { sessionId: string; reason: string };
  forkedFrom?: { sessionId: string; reason: string };
  guard?: import("./guard").GuardMode;
  /** timed full access: when it ends (epoch ms), and the mode it goes back to then */
  guardUntil?: number;
  guardBefore?: import("./guard").GuardMode;
  /** timed full access ended while the session wasn't running: said inline when it next opens */
  guardEnded?: import("./guard").GuardMode;
  /**
   * The judge's denials still waiting on the owner (blocked tickets): what "Approve & retry" and
   * "Run it myself" act on once the process that saw them has closed or the runner restarted.
   */
  blocked?: { toolId: string; name: string; input: unknown; reason: string; at: number }[];
  checkpoints?: import("../../web/src/shared/protocol").Checkpoint[];
  /** First working-tree snapshot, used to show changes made across the whole Tether session. */
  diffBaseSha?: string;
  /** a turn was in progress (running or waiting): resume it after a runner restart */
  active?: boolean;
  /** fallback was waiting on a usage limit or a backoff until then: re-armed after a restart */
  waitingUntil?: number;
  waitingReason?: string;
  projectPath?: string;
  /** background tasks running when last saved (reported to the agent if a restart stops them) */
  background?: { id: string; description: string; type?: string }[];
  /** messages sent but not yet taken by the agent; resent after a runner restart */
  pending?: { id: string; text: string; mode: "steer" | "followUp"; ts: number; scheduleId?: string; alone?: boolean }[];
  /** the model, effort and mode it last ran with, re-applied on resume (session.reapplyChoices) */
  model?: string;
  /** the credential its process runs on (credentials/registry.ts), set again before a resume starts it */
  credential?: string;
  thinking?: string;
  permissionMode?: string;
  /** the modes and effort levels the harness offered when it last ran (pickers of a session that isn't running) */
  modes?: string[];
  thinkingLevels?: string[];
  /** last known context-window fill, for harnesses that can't report it again on resume */
  context?: import("../../web/src/shared/protocol").ContextUsage;
  /** the session's goal (/goal, runner/src/goal.ts) */
  goal?: import("../../web/src/shared/protocol").SessionGoal;
  /** the session's plan and todo list (plan_set / todo_set, runner/src/plan.ts) */
  plan?: import("../../web/src/shared/protocol").SessionPlan;
  /** Tether's loops and schedules (/loop, /schedule, runner/src/schedule.ts) */
  schedules?: import("../../web/src/shared/protocol").SessionSchedule[];
  /** reviews of this session's changes (/review, runner/src/review.ts) */
  reviews?: import("../../web/src/shared/protocol").SessionReview[];
  /** this session is a read-only review of another one */
  reviewOf?: { sessionId: string; reviewId: string };
  /** cross-harness subagents it started (agent_start, runner/src/crossAgents.ts) */
  subagents?: import("../../web/src/shared/protocol").SubagentLink[];
  /** it is a cross-harness subagent: who started it */
  startedBy?: import("../../web/src/shared/protocol").StartedBy;
}

const defaults = (): RunnerConfig => ({
  runnerId: hostname(),
  projects: [],
  hidden: [],
  archived: [],
  titles: {},
  exhausted: {},
  sessions: {},
});

let cached: RunnerConfig | undefined;

export function config(): RunnerConfig {
  if (cached) return cached;
  try {
    cached = { ...defaults(), ...JSON.parse(readFileSync(CONFIG_FILE, "utf8")) };
  } catch {
    cached = defaults();
  }
  migrateJudge(cached!);
  dropLeader(cached!);
  migrateProfiles(cached!);
  return cached!;
}

/** The leader agent is gone: an older config's keys for it are dropped (its session stays an ordinary one). */
export function dropLeader(cfg: RunnerConfig): void {
  const old = cfg as RunnerConfig & { leader?: unknown };
  delete old.leader;
  if (cfg.ui) delete (cfg.ui as Record<string, unknown>).leaderUpdates;
  for (const p of Object.values(cfg.sessions ?? {})) {
    delete (p as Record<string, unknown>).leader;
    delete (p as Record<string, unknown>).createdBy;
  }
}

/** Named profiles older versions shipped (written into runner.json as defaults, or merged in at run time). */
const SHIPPED_PROFILES: Record<string, string[]> = {
  "codex-current": ["codex:gpt-6.1-sol", "codex:gpt-6-sol", "codex:gpt-6-luna", "codex:gpt-6-astra"],
  luna: ["pi:openai-codex/gpt-6-luna", "pi:azure/gpt-6-luna"],
  "claude-then-luna": ["claude-code:opus", "pi:openai-codex/gpt-6-luna", "pi:azure/gpt-6-luna"],
};

/**
 * Named model profiles are gone: one default order replaces them. The first profile the user made
 * (not one Tether shipped, unless its models were changed) seeds the default order when none is
 * set; otherwise it stays unset. A session that picked a profile already has its own copy in
 * `chain` (one that somehow doesn't gets it now), and the profile name goes. Idempotent.
 */
export function migrateProfiles(cfg: RunnerConfig): void {
  const old = cfg as RunnerConfig & { profiles?: unknown };
  const list = Array.isArray(old.profiles) ? (old.profiles as { name?: unknown; chain?: unknown }[]) : [];
  const clean = list
    .map((p) => ({
      name: typeof p?.name === "string" ? p.name.trim() : "",
      chain: Array.isArray(p?.chain) ? (p.chain as unknown[]).filter((c): c is string => typeof c === "string").map((c) => c.trim()).filter(Boolean) : [],
    }))
    .filter((p) => p.chain.length);
  const shipped = (p: { name: string; chain: string[] }) => JSON.stringify(SHIPPED_PROFILES[p.name]) === JSON.stringify(p.chain);
  const mine = clean.find((p) => !shipped(p));
  // The default order's entries always name their harness (a profile's bare model was Claude Code's).
  const order = mine && [...new Set(mine.chain.map(normalizeModelEntry).filter((e): e is string => !!e))];
  if (order?.length && !cfg.defaultOrder?.length) cfg.defaultOrder = order;
  for (const s of Object.values(cfg.sessions ?? {})) {
    const p = s as SessionPrefs & { profile?: unknown };
    if (p.profile === undefined) continue;
    if (!p.chain?.length && typeof p.profile === "string") {
      const chain = clean.find((x) => x.name === p.profile)?.chain ?? SHIPPED_PROFILES[p.profile];
      if (chain) p.chain = [...chain];
    }
    delete p.profile;
  }
  delete old.profiles;
}

/**
 * A model setting as exactly "harness:model". Accepts what older configs and callers stored: a
 * bare Claude model ("haiku"), or a doubled prefix ("claude-code:codex:gpt-5-mini", from an old
 * fallback that prefixed a value that already had a harness). Undefined for empty / "off".
 */
export function normalizeModelEntry(v: string | undefined): string | undefined {
  const s = v?.trim();
  if (!s || s === "off") return undefined;
  let e = parseEntry(s, "claude-code");
  for (let i = 0; i < 4; i++) {
    const inner = HARNESSES.find((h) => e.model.startsWith(h.id + ":"));
    if (!inner) break;
    e = parseEntry(e.model, inner.id);
  }
  return e.model ? formatEntry(e) : undefined;
}

/** guard.judgeModel (legacy) → backgroundModel + guard.judge. Idempotent. */
export function migrateJudge(cfg: RunnerConfig): boolean {
  const before = JSON.stringify([cfg.guard, cfg.backgroundModel]);
  const g = cfg.guard;
  const legacy = g?.judgeModel?.trim();
  if (g && legacy === "off") g.judge = false;
  else if (g && legacy) {
    cfg.backgroundModel ??= normalizeModelEntry(legacy);
    delete g.judgeModel;
  }
  if (g && g.judge === false) g.judgeModel = "off"; // keeps an older runner's judge off too
  const bg = normalizeModelEntry(cfg.backgroundModel);
  if (bg) cfg.backgroundModel = bg;
  else delete cfg.backgroundModel;
  return JSON.stringify([cfg.guard, cfg.backgroundModel]) !== before;
}

/** Each preference's check, and what a refused value is told. */
const UI_PREF_CHECKS: { [K in keyof UiPrefs]: [(v: unknown) => boolean, string] } = {
  sidebarDays: [(v) => (SIDEBAR_DAYS as readonly unknown[]).includes(v), `one of ${SIDEBAR_DAYS.join(", ")}`],
  expandShell: [(v) => typeof v === "boolean", "true or false"],
};
const uiKeys = Object.keys(UI_PREF_CHECKS) as (keyof UiPrefs)[];

/** The web app's preferences, defaults filled in (a bad hand-edited value reads as the default). */
export function uiPrefs(): UiPrefs {
  const ui = config().ui ?? {};
  return Object.fromEntries(uiKeys.map((k) => [k, UI_PREF_CHECKS[k][0](ui[k]) ? ui[k] : DEFAULT_UI_PREFS[k]])) as unknown as UiPrefs;
}

/** Saves the given preferences. An unknown value is refused and nothing changes; unknown keys are ignored. */
export function setUiPrefs(p: Partial<UiPrefs>): UiPrefs {
  const given = uiKeys.filter((k) => p[k] !== undefined);
  for (const k of given) if (!UI_PREF_CHECKS[k][0](p[k])) throw new Error(`${k} must be ${UI_PREF_CHECKS[k][1]}`);
  const cfg = config();
  if (given.length) cfg.ui = { ...cfg.ui, ...Object.fromEntries(given.map((k) => [k, p[k]])) };
  saveConfig();
  return uiPrefs();
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** Coalesces frequent writes (session state changes). */
export function saveConfigSoon(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveConfig, 500);
}

export function prefs(sessionId: string): SessionPrefs {
  const all = config().sessions;
  return (all[sessionId] ??= {});
}

let frozen = false;

/**
 * Writes the config one last time and ignores every later save. Used on shutdown: closing the
 * sessions makes them look idle, which must not overwrite what was running when the stop came.
 */
export function freezeConfig(): void {
  clearTimeout(saveTimer);
  saveConfig();
  frozen = true;
}

export function saveConfig(): void {
  if (frozen) return;
  mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = CONFIG_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(config(), null, 2));
  renameSync(tmp, CONFIG_FILE);
}
