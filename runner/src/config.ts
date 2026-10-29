// The runner's directory and its small state file (SPEC §4): runner.json, mode 600: the runner's
// id, per-session prefs, queued messages, read state and open requests. Never transcripts.

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import type { QueuedMessage } from "../../shared/transcript";
import type { ClosedRequest, SavedRequest } from "./core/broker";

export const CONFIG_DIR = process.env.TETHER_CONFIG_DIR || join(homedir(), ".config", "tether");
export const CONFIG_FILE = join(CONFIG_DIR, "runner.json");

export interface RunnerConfig {
  /**
   * Unique and stable: generated on first start and kept. Two runners must never share one (the
   * server lets the newer connection replace the older), so it is not the hostname.
   */
  runnerId: string;
  /** what people see; the hostname unless set */
  name?: string;
  /** per-session settings Tether chose (SPEC §4), by session id */
  sessions?: Record<string, SessionPrefs>;
  /** approvals and questions still waiting for a person (SPEC §7): they survive a restart */
  requests?: SavedRequest[];
  /** recently closed request ids, so an answer arriving after a restart is still told "Already answered." */
  closedRequests?: ClosedRequest[];
}

/** What Tether keeps for a session: the settings picked for it, applied when it (re)starts. */
export interface SessionPrefs {
  projectPath?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  /** a turn was running: still set at start means it was cut off (a runner restart, a crash) */
  running?: boolean;
  /** messages waiting to go out after the running turn (SPEC §9) */
  queue?: QueuedMessage[];
  /** the queue waits until released, and why (LiveState.queueHeldBy) */
  queueHeldBy?: "terminal" | "stopped" | "restart" | "failed";
  /** a turn ended and nobody has looked since (Home's inbox) */
  unread?: "finished" | "failed";
  /** the failed turn's error */
  failure?: string;
  /** last touched; old entries are dropped */
  at?: number;
}

/** Loads runner.json, creating it with a fresh id the first time. */
export function loadConfig(file = CONFIG_FILE): RunnerConfig {
  let saved: Partial<RunnerConfig> = {};
  try {
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw new Error(`Can't read ${file}: ${e?.message ?? e}`);
  }
  if (typeof saved.runnerId === "string" && saved.runnerId.trim()) return saved as RunnerConfig;
  const cfg: RunnerConfig = { ...saved, runnerId: randomUUID() };
  saveConfig(cfg, file);
  return cfg;
}

export const displayName = (cfg: RunnerConfig) => (typeof cfg.name === "string" && cfg.name.trim()) || hostname();

/** Atomic and private: written to a temp file, then renamed over the old one. */
export function saveConfig(cfg: RunnerConfig, file = CONFIG_FILE) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
