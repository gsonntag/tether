// The runner's directory and its small state file (SPEC §4): runner.json, mode 600. Later phases
// add session modes, prefs, queued messages and open requests here. Never transcripts.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = process.env.TETHER_CONFIG_DIR || join(homedir(), ".config", "tether");
const CONFIG_FILE = join(CONFIG_DIR, "runner.json");

export interface RunnerConfig {
  /** this machine's name in Tether; defaults to the hostname */
  runnerId: string;
}

const defaults = (): RunnerConfig => ({ runnerId: hostname() });

export function loadConfig(file = CONFIG_FILE): RunnerConfig {
  let saved: Partial<RunnerConfig> = {};
  try {
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw new Error(`Can't read ${file}: ${e?.message ?? e}`);
  }
  const cfg = { ...defaults(), ...saved };
  if (typeof cfg.runnerId !== "string" || !cfg.runnerId.trim()) cfg.runnerId = defaults().runnerId;
  return cfg;
}

/** Atomic and private: written to a temp file, then renamed over the old one. */
export function saveConfig(cfg: RunnerConfig, file = CONFIG_FILE) {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
