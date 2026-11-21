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
  /** TETHER_HIDE_PROJECTS folders, together, unnamed */
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

/** One runner's row in "All runners": its totals, and why it's missing if it is. */
export interface UsageRunner extends UsageTotals { id: string; name: string }

/** Settings → Usage, All runners: every reachable runner's report together. */
export interface CombinedUsage extends UsageReport {
  /** each runner whose report came, in the order given */
  byRunner: UsageRunner[];
}

/** How many named projects the combined table keeps before "N other projects" (as a runner does). */
export const COMBINED_TOP_PROJECTS = 8;

const worth = (a: UsageTotals, b: UsageTotals) => b.usd - a.usd || totalTokens(b) - totalTokens(a);
const copy = <T extends UsageTotals>(t: T): T => ({ ...t, sources: Object.fromEntries(USAGE_SOURCES.map((s) => [s, { ...t.sources[s] }])) as UsageTotals["sources"] });

/**
 * Several runners' reports as one: totals summed, days merged by day, models by harness and model,
 * projects by folder (re-ranked: the top named ones, the rest as one row, hidden ones as one), plan
 * limits named by runner, the scan running if any is and as old as the oldest. Reports are for the
 * same range and zone; a day only some have still counts.
 */
export function combineUsage(parts: { id: string; name: string; report: UsageReport }[]): CombinedUsage {
  const reports = parts.map((p) => p.report);
  const first = reports[0];
  const total = emptyTotals();
  const days = new Map<string, UsageDay>();
  const models = new Map<string, UsageModel>();
  const named = new Map<string, UsageProject>();
  const unknownFolder: UsageProject = { name: "Unknown folder", ...emptyTotals() };
  const hidden: UsageProject = { name: "Hidden projects", hidden: true, ...emptyTotals() };
  const others: UsageProject = { name: "", others: 0, ...emptyTotals() };
  let ledger: UsageReport["ledger"];
  const scan: UsageReport["scan"] = { running: false, files: 0, done: 0, errors: 0 };
  let skipped = 0;
  const ats: number[] = [];
  let ms = 0;
  for (const r of reports) {
    addTotals(total, r.total);
    for (const d of r.byDay) {
      const had = days.get(d.day);
      if (had) addTotals(had, d);
      else days.set(d.day, copy(d));
    }
    for (const m of r.byModel) {
      const k = `${m.harness}\u0000${m.model}`;
      const had = models.get(k);
      if (had) addTotals(had, m);
      else models.set(k, copy(m));
    }
    for (const p of r.byProject) {
      if (p.hidden) addTotals(hidden, p);
      else if (p.others !== undefined) (addTotals(others, p), (others.others! += p.others));
      else if (!p.path) addTotals(unknownFolder, p);
      else {
        const had = named.get(p.path);
        if (had) addTotals(had, p);
        else named.set(p.path, copy(p));
      }
    }
    if (r.ledger) {
      ledger ??= { usd: 0, sessions: 0, complete: true };
      ledger.usd += r.ledger.usd;
      ledger.sessions += r.ledger.sessions;
      if (!r.ledger.complete) ledger.complete = false;
    }
    scan.running ||= r.scan.running;
    scan.files += r.scan.files;
    scan.done += r.scan.done;
    scan.errors += r.scan.errors;
    skipped += r.scan.skipped ?? 0;
    if (r.scan.at !== undefined) ats.push(r.scan.at);
    ms = Math.max(ms, r.scan.ms ?? 0);
  }
  if (unknownFolder.requests) named.set("", unknownFolder);
  const ranked = [...named.values()].sort(worth);
  const byProject = ranked.slice(0, COMBINED_TOP_PROJECTS);
  const rest = ranked.slice(COMBINED_TOP_PROJECTS);
  // One project left over and no runner's own "other projects": it keeps its name.
  if (rest.length === 1 && !others.others) byProject.push(rest[0]!);
  else {
    for (const p of rest) (addTotals(others, p), (others.others! += 1));
    if (others.others) byProject.push({ ...others, name: `${others.others} other projects` });
  }
  if (hidden.requests) byProject.push(hidden);
  // Every runner has been read only as recently as the one read longest ago; not at all if one hasn't been.
  if (ats.length && ats.length === reports.length) scan.at = Math.min(...ats);
  if (ms) scan.ms = ms;
  if (skipped) scan.skipped = skipped;
  const byDay = [...days.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return {
    days: first?.days ?? 0,
    timeZone: first?.timeZone ?? "UTC",
    from: reports.map((r) => r.from).sort()[0] ?? "",
    to: reports.map((r) => r.to).sort().at(-1) ?? "",
    total,
    byDay,
    byModel: [...models.values()].sort(worth),
    byProject,
    ...(ledger ? { ledger } : {}),
    plans: parts.flatMap((p) => p.report.plans.map((pl) => ({ ...pl, label: parts.length > 1 ? `${pl.label} · ${p.name}` : pl.label }))),
    scan,
    byRunner: parts.map((p) => ({ id: p.id, name: p.name, ...copy(p.report.total) })),
  };
}
