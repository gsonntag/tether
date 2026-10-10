import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { ModelProfile } from "../../web/src/shared/protocol";

export const CONFIG_DIR = process.env.TETHER_CONFIG_DIR ?? join(homedir(), ".config", "tether");
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
  guard?: { judgeModel?: string; defaultMode?: import("./guard").GuardMode };
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
  checkpoints?: { id: string; sha: string; ts: number; label: string }[];
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
  return cached!;
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
