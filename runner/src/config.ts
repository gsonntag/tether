import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { formatEntry, HARNESSES, parseEntry, type ModelProfile } from "../../web/src/shared/protocol";

// $HOME first (as context/paths.ts does), so a runner launched with a scratch HOME never falls
// back to the account's real home through the password database.
export const CONFIG_DIR = process.env.TETHER_CONFIG_DIR ?? join(process.env.HOME || homedir(), ".config", "tether");
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
  profiles: ModelProfile[];
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
  /** master context: off until the first import is run from the UI */
  context?: { enabled?: boolean; importedAt?: number };
  /** Web Push: this runner's VAPID key, subscribed devices, recent notifications */
  push?: { vapid?: { publicKey: string; privateKey: string }; subs: import("./notify").PushSub[]; recent: import("../../web/src/shared/protocol").AgentNotice[] };
}

export interface SessionPrefs {
  chain?: string[];
  profile?: string;
  preferEarlier?: boolean;
  handoffFrom?: { sessionId: string; reason: string };
  handoffTo?: { sessionId: string; reason: string };
  guard?: import("./guard").GuardMode;
  checkpoints?: import("../../web/src/shared/protocol").Checkpoint[];
  /** First working-tree snapshot, used to show changes made across the whole Tether session. */
  diffBaseSha?: string;
  /** a turn was in progress (running or waiting): resume it after a runner restart */
  active?: boolean;
  projectPath?: string;
  /** background tasks running when last saved (reported to the agent if a restart stops them) */
  background?: { id: string; description: string; type?: string }[];
  /** messages sent but not yet taken by the agent; resent after a runner restart */
  pending?: { id: string; text: string; mode: "steer" | "followUp"; ts: number }[];
  /** last known context-window fill, for harnesses that can't report it again on resume */
  context?: import("../../web/src/shared/protocol").ContextUsage;
}

/** Current Codex lineup used by the built-in fallback profile. The picker remains catalog-driven. */
export const BUILTIN_PROFILES: ModelProfile[] = [
  {
    name: "codex-current",
    chain: ["codex:gpt-6.1-sol", "codex:gpt-6-sol", "codex:gpt-6-luna", "codex:gpt-6-astra"],
  },
];

export function availableProfiles(): ModelProfile[] {
  const configured = config().profiles;
  const names = new Set(configured.map((p) => p.name));
  return [...configured, ...BUILTIN_PROFILES.filter((p) => !names.has(p.name)).map((p) => ({ ...p, chain: [...p.chain] }))];
}

const defaults = (): RunnerConfig => ({
  runnerId: hostname(),
  projects: [],
  hidden: [],
  archived: [],
  titles: {},
  profiles: [
    { name: "luna", chain: ["pi:openai-codex/gpt-6-luna", "pi:azure/gpt-6-luna"] },
    { name: "claude-then-luna", chain: ["claude-code:opus", "pi:openai-codex/gpt-6-luna", "pi:azure/gpt-6-luna"] },
  ],
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
  return cached!;
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
