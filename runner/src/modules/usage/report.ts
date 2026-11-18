// The usage op's answer from the scanner's records: deduped across files, bucketed by day in the
// browser's time zone, priced, by model and by project.

import { basename } from "node:path";
import { emptyTotals, totalTokens, type UsageModel, type UsageProject, type UsageReport, type UsageTotals } from "../../../../shared/usage";
import type { FileState } from "./parse";
import { priceRec } from "./price";

export type Source = "plan" | "key" | "unknown";
/** What a file's requests drew from: `kind` from `since` (ms) on, `before` (default unknown) earlier. */
export interface SourceSpan { kind: Source; since?: number; before?: Source }

/** How many projects get a row of their own. */
export const TOP_PROJECTS = 8;

/** YYYY-MM-DD of a time (s) in a zone. Every zone's offset is a whole number of quarter hours, so it's cached per quarter hour. */
export function dayKeyer(timeZone: string): (t: number) => string {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const cache = new Map<number, string>();
  return (t) => {
    const q = Math.floor(t / 900);
    let key = cache.get(q);
    if (key === undefined) {
      const p = Object.fromEntries(fmt.formatToParts(q * 900_000).map((x) => [x.type, x.value]));
      key = `${p.year}-${p.month}-${p.day}`;
      cache.set(q, key);
    }
    return key;
  };
}

/** The `days` calendar days ending with `today` (YYYY-MM-DD), oldest first. */
export function dayRange(today: string, days: number): string[] {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  return Array.from({ length: days }, (_, i) => new Date(Date.UTC(y, m - 1, d - (days - 1 - i))).toISOString().slice(0, 10));
}

export interface ReportInput {
  files: Iterable<[string, FileState]>;
  days: number;
  timeZone: string;
  now: number;
  /** what a file's requests drew from */
  source: (f: FileState) => Source | SourceSpan;
  /** a folder TETHER_HIDE_PROJECTS (or the Home agent) hides */
  hidden?: (path: string) => boolean;
  /** Tether's API cost ledger: whole-session totals by Tether session id */
  ledger?: (sessionId: string) => { usd?: number; complete: boolean } | undefined;
}

function add(t: UsageTotals, r: { input: number; output: number; cacheRead: number; cacheWrite: number }, price: { usd: number; savings: number } | undefined, source: Source) {
  t.input += r.input;
  t.output += r.output;
  t.cacheRead += r.cacheRead;
  t.cacheWrite += r.cacheWrite;
  t.requests++;
  if (!price) {
    t.unpriced++;
    return;
  }
  t.usd += price.usd;
  t.savings += price.savings;
  t[source] += price.usd;
}

const byWorth = (a: UsageTotals, b: UsageTotals) => b.usd - a.usd || totalTokens(b) - totalTokens(a);

export function buildReport(o: ReportInput): Omit<UsageReport, "plans" | "scan"> {
  const key = dayKeyer(o.timeZone);
  const range = dayRange(key(o.now / 1000), o.days);
  const from = range[0]!, to = range[range.length - 1]!;
  // Anything in range is newer than this (a day and a half's slack covers every zone's offset).
  const since = o.now / 1000 - (o.days + 1.5) * 86_400;
  const total = emptyTotals();
  const days = new Map(range.map((day) => [day, { day, ...emptyTotals() }]));
  const models = new Map<string, UsageModel>();
  const projects = new Map<string, UsageProject>();
  const hiddenRow: UsageProject = { name: "Hidden projects", hidden: true, ...emptyTotals() };
  const seen = new Set<string>();
  const sessions = new Set<string>();
  // Files in a fixed order, so which copy of a repeated request counts doesn't change between answers.
  const files = [...o.files].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [, f] of files) {
    const got = o.source(f);
    const span = typeof got === "string" ? { kind: got } : got;
    const path = f.project;
    const hide = !!path && !!o.hidden?.(path);
    let any = false;
    for (const r of f.recs) {
      if (r[1] < since || seen.has(r[0])) continue;
      const day = days.get(key(r[1]));
      if (!day) continue;
      seen.add(r[0]);
      any = true;
      const source = r[1] * 1000 >= (span.since ?? 0) ? span.kind : (span.before ?? "unknown");
      const tokens = { input: r[3], output: r[4], cacheRead: r[5], cacheWrite: r[6] + r[7] };
      const price = priceRec(f.harness, r, f.harness === "codex" ? f.provider : undefined);
      add(total, tokens, price, source);
      add(day, tokens, price, source);
      const mk = `${f.harness}\u0000${r[2]}`;
      let m = models.get(mk);
      if (!m) models.set(mk, (m = { harness: f.harness, model: r[2], ...emptyTotals() }));
      add(m, tokens, price, source);
      let p = hide ? hiddenRow : projects.get(path ?? "");
      if (!p) projects.set(path ?? "", (p = path ? { path, name: basename(path) || path, ...emptyTotals() } : { name: "Unknown folder", ...emptyTotals() }));
      add(p, tokens, price, source);
    }
    if (any && f.session) sessions.add(`${f.harness}:${f.session}`);
  }
  const ranked = [...projects.values()].sort(byWorth);
  const byProject = ranked.slice(0, TOP_PROJECTS);
  const rest = ranked.slice(TOP_PROJECTS);
  if (rest.length === 1) byProject.push(rest[0]!);
  else if (rest.length) {
    const other: UsageProject = { name: `${rest.length} other projects`, others: rest.length, ...emptyTotals() };
    for (const p of rest) for (const k of Object.keys(emptyTotals()) as (keyof UsageTotals)[]) other[k] += p[k];
    byProject.push(other);
  }
  if (hiddenRow.requests) byProject.push(hiddenRow);
  let ledger: UsageReport["ledger"];
  for (const id of sessions) {
    const entry = o.ledger?.(id);
    if (!entry) continue;
    ledger ??= { usd: 0, sessions: 0, complete: true };
    ledger.sessions++;
    if (typeof entry.usd === "number") ledger.usd += entry.usd;
    if (!entry.complete || typeof entry.usd !== "number") ledger.complete = false;
  }
  return {
    days: o.days,
    timeZone: o.timeZone,
    from,
    to,
    total,
    byDay: [...days.values()],
    byModel: [...models.values()].sort(byWorth),
    byProject,
    ...(ledger ? { ledger } : {}),
  };
}

const KEY_PROVIDERS = ["tether_openai", "tether_azure", "azure"];
/** Codex: what a thread drew from, by its rollout. A private home or a key's provider is a key; OpenAI's own with plan limits in its token counts is the plan. */
export function codexSource(f: FileState): Source {
  if (f.private || KEY_PROVIDERS.includes(f.provider ?? "")) return "key";
  return f.provider === "openai" && f.plan ? "plan" : "unknown";
}
