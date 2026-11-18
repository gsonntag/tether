// Settings → Usage (SPEC §10 Usage): the `usage` op's answer. The runner reads the harness stores
// (Claude's JSONL `usage`, Codex's rollout token counts), so it covers every session on the machine,
// Tether's or not. Dollars are estimates at published API prices; a request whose model has no
// published price counts its tokens and no dollars (`unpriced`).

import type { HarnessId, PlanUsage } from "./transcript";

/** The most days the op answers for. */
export const USAGE_DAYS_MAX = 30;

/**
 * Tokens as the API bills them: `input` is the uncached part, `cacheRead` what came from the cache,
 * `cacheWrite` what was written to it (Claude's 5-minute and 1-hour writes, Codex's writes).
 */
export interface UsageTokens { input: number; output: number; cacheRead: number; cacheWrite: number }

/**
 * What requests drew from, as the harness or Tether recorded it: a plan, an API key, a provider
 * (Bedrock, Vertex, Foundry, a gateway, Azure: their own prices, none here), or not known.
 */
export type UsageSource = "plan" | "key" | "provider" | "unknown";
export const USAGE_SOURCES: UsageSource[] = ["plan", "key", "provider", "unknown"];

/** One source's part of a row: its requests, the API price of those priced, and how many weren't. */
export interface SourcePart { requests: number; usd: number; unpriced: number }

export interface UsageTotals extends UsageTokens {
  /** model requests (one per API response) */
  requests: number;
  /** what the priced requests would cost on the API, USD, estimated */
  usd: number;
  /** requests with no published price: their tokens are counted, their dollars aren't */
  unpriced: number;
  /** the same by source: a part with unpriced requests is a partial subtotal */
  sources: Record<UsageSource, SourcePart>;
  /** cache reads at the full input price, less what they cost: what caching saved, estimated */
  savings: number;
}

export interface UsageDay extends UsageTotals { day: string }
export interface UsageModel extends UsageTotals { harness: HarnessId; model: string }
export interface UsageProject extends UsageTotals {
  /** its folder; absent for the rows that group others */
  path?: string;
  name: string;
  /** TETHER_HIDE_PROJECTS folders (and the Home agent's), together, unnamed */
  hidden?: boolean;
  /** the smaller projects, together: how many */
  others?: number;
}

export interface UsageReport {
  days: number;
  /** the IANA zone days are in (the browser's, else UTC) */
  timeZone: string;
  /** first and last day, YYYY-MM-DD in `timeZone` */
  from: string;
  to: string;
  total: UsageTotals;
  /** every day of the range, oldest first, empty days included */
  byDay: UsageDay[];
  /** by harness and model, priced dollars first */
  byModel: UsageModel[];
  /** the top projects, then the rest together, then hidden ones together */
  byProject: UsageProject[];
  /** what Tether's API session ledger holds for the sessions with usage in the range: whole-session totals */
  ledger?: { usd: number; sessions: number; complete: boolean };
  /** each harness's latest plan limits report */
  plans: { harness: HarnessId; label: string; plan: PlanUsage }[];
  scan: {
    /** reading the stores now: what's here is what's read so far */
    running: boolean;
    files: number;
    done: number;
    /** when the last whole scan ended, and how long it took (ms) */
    at?: number;
    ms?: number;
    /** folders and files that couldn't be read */
    errors: number;
    /** lines too long to read (over 64 MB), skipped */
    skipped?: number;
  };
}

const part = (): SourcePart => ({ requests: 0, usd: 0, unpriced: 0 });
export const emptyTotals = (): UsageTotals => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, usd: 0, unpriced: 0, savings: 0,
  sources: { plan: part(), key: part(), provider: part(), unknown: part() },
});

/** Adds `b` into `a`. */
export function addTotals(a: UsageTotals, b: UsageTotals) {
  for (const k of ["input", "output", "cacheRead", "cacheWrite", "requests", "usd", "unpriced", "savings"] as const) a[k] += b[k];
  for (const s of USAGE_SOURCES) for (const k of ["requests", "usd", "unpriced"] as const) a.sources[s][k] += b.sources[s][k];
}

export const totalTokens = (t: UsageTokens) => t.input + t.output + t.cacheRead + t.cacheWrite;

/** A time zone the runner can bucket by: the name if it's a real IANA zone, else UTC. */
export function validTimeZone(tz: unknown): string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}
