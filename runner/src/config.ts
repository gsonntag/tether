// The runner's directory and its small state file (SPEC §4): runner.json, mode 600: the runner's
// id, per-session prefs, queued messages, pending retry payloads, read state and open requests.
// Complete transcripts stay in the harness's own store.

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import type { BillingSource, CredentialSource } from "../../shared/credentials";
import type { RunnerSettings } from "../../shared/protocol";
import type { Billing, HarnessId, QueuedMessage } from "../../shared/transcript";
import type { ClosedRequest, SavedRequest } from "./core/broker";
import type { SavedRetry } from "./core/retryPolicy";

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
  /** runner-wide settings (the Settings page) */
  settings?: RunnerSettings;
  /** per-session settings Tether chose (SPEC §4), by session id */
  sessions?: Record<string, SessionPrefs>;
  /** approvals and questions still waiting for a person (SPEC §7): they survive a restart */
  requests?: SavedRequest[];
  /** recently closed request ids, so an answer arriving after a restart is still told "Already answered." */
  closedRequests?: ClosedRequest[];
}

/** What Tether keeps for a session: the settings picked for it, applied when it (re)starts. */
export interface SessionPrefs {
  retry?: SavedRetry;
  /** A title chosen in Tether, kept across harness discovery and process restarts. */
  title?: string;
  /** Kept out of Recent while remaining available through explicit search. */
  archived?: boolean;
  /** When it was pinned (ms): the Sidebar's Pinned group, oldest pin first. Archiving unpins. */
  pinned?: number;
  /** A pinned session's row as last seen (from its pin on): listed from this when its harness can't find it. */
  pinnedRow?: { title: string; projectPath: string; updatedAt: number };
  projectPath?: string;
  /** a new session that hasn't had a message: opening its id brings it back as new (sessions.ts make) */
  blank?: boolean;
  /** a blank session that went on under another id (Adapter.renew) */
  movedTo?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  /** the mode the session left for plan mode: approving a plan goes back to it */
  beforePlan?: string;
  /** what the session draws from, on every start, whatever keys are set later. Never a key itself */
  source?: BillingSource;
  /** on Azure: the deployment it runs on, kept across restarts. Removed from Settings, the session stops */
  deployment?: string;
  /** on Azure: a deployment picked while a turn ran, applied at the next send (its process restarts priced for it) */
  nextDeployment?: string;
  /** a source picked for the next process start, until the harness confirms it */
  nextBilling?: Billing;
  /** a start for nextBilling failed; shown until a retry succeeds or the source is cancelled */
  sourceSwitchFailed?: boolean;
  /** with capabilities.sourceCarry: the source the next message goes to, in a new thread */
  nextSource?: BillingSource;
  /** switch to a key when the plan runs out, the one exception to no fallback (SPEC §10). Ticked by you */
  autoKey?: boolean;
  /** the key this session last used or had picked */
  lastKey?: BillingSource;
  /** Allowed automatic fallback keys, in priority order. Empty excludes all keys. */
  fallbackKeys?: CredentialSource[];
  /** its API cost has had an entry in costs.json: one missing there now was lost, not never needed */
  metered?: boolean;
  /** a thread being made for a source change: nobody's until its first message has an answer */
  carrying?: boolean;
  /** with movedTo: replaced by a thread on another source, so it isn't anyone's to see */
  carried?: boolean;
  /** a turn was running: still set at start means it was cut off (a runner restart, a crash); through the quiet wait too */
  running?: boolean;
  /** the subagents running now (kept so a restart can tell the agent which ones it lost) */
  liveSubagents?: { title: string; agentType?: string }[];
  /** a turn a restart cut off, recorded (Home shows it once): its notice goes in when the session is read */
  cutOff?: boolean;
  /** when the quiet wait after a restart began: set until it resolves, across further restarts (live.ts autoContinue) */
  restartWait?: number;
  /** when Tether last continued a turn a restart cut off (a restart soon after doesn't continue again) */
  autoContinuedAt?: number;
  /** how many times Tether continued the running turn after restarts (live.ts AUTO_CONTINUE_MAX); cleared when it ends */
  continues?: number;
  /** messages waiting to go out after the running turn (SPEC §9) */
  queue?: QueuedMessage[];
  /** the queue waits until released, and why (LiveState.queueHeldBy) */
  queueHeldBy?: "terminal" | "stopped" | "restart" | "failed";
  /** its TUI was started and hasn't been seen gone; `entries`: the mode entries its store had then (only later ones are that TUI's) */
  tui?: { entries?: number };
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

/** The name set in runner.json; else the hostname, unless it's a cloud default like `instance-20260403-0633`. */
export const displayName = (cfg: RunnerConfig, host = hostname()) =>
  (typeof cfg.name === "string" && cfg.name.trim()) || (isGeneratedHostname(host) ? niceName(cfg.runnerId) : host);

/** A runner name as typed: trimmed, one line, at most 60 characters. Blank: none. */
export function cleanRunnerName(v: unknown): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim() : "";
}

/** Hostnames a provider or container runtime made up, not a person: they say nothing in a list of computers. */
export function isGeneratedHostname(host: string): boolean {
  const h = host.trim().toLowerCase().split(".")[0] ?? "";
  return (
    !h ||
    h === "localhost" ||
    /^instance-\d{8}-\d{4}$/.test(h) || // Oracle Cloud
    /^instance-\d+$/.test(h) || // Google Cloud
    /^(ip|domu)-[0-9a-f-]+$/.test(h) || // AWS
    /^(vm|ubuntu|debian|server|host|node|droplet|vps)-?[0-9a-f-]*\d[0-9a-f-]*$/.test(h) || // vm-1234, ubuntu-s-1vcpu… style
    /^[0-9a-f]{12}$/.test(h) || // Docker container id
    /^[0-9a-f-]{32,36}$/.test(h)
  );
}

const ADJECTIVES = ["Amber", "Brisk", "Cedar", "Copper", "Crimson", "Dusky", "Ember", "Fable", "Frost", "Golden", "Hazel", "Indigo", "Ivory", "Jade", "Juniper", "Lunar", "Maple", "Misty", "Nimble", "Ochre", "Opal", "Quiet", "Rustic", "Sable", "Saffron", "Silver", "Solar", "Swift", "Teal", "Velvet", "Willow", "Zephyr"];
const NOUNS = ["Badger", "Comet", "Crane", "Falcon", "Fern", "Finch", "Fox", "Harbor", "Heron", "Lark", "Lynx", "Meadow", "Moose", "Orca", "Otter", "Owl", "Panda", "Pine", "Quail", "Raven", "Ridge", "River", "Robin", "Sparrow", "Summit", "Tiger", "Tundra", "Valley", "Walrus", "Wolf", "Wren", "Yak"];

/** A friendly name that stays the same for a runner id: "Copper Heron". */
export function niceName(seed: string): string {
  const d = createHash("sha256").update(seed).digest();
  return `${ADJECTIVES[d[0]! % ADJECTIVES.length]} ${NOUNS[d[1]! % NOUNS.length]}`;
}

/** Atomic and private: written to a temp file, then renamed over the old one. */
export function saveConfig(cfg: RunnerConfig, file = CONFIG_FILE) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
