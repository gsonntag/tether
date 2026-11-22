// The usage op's answer from the scanner's records: merged across files, bucketed by day in the
// browser's time zone, priced, by model and by project.

import { basename } from "node:path";
import { addTotals, emptyTotals, totalTokens, type UsageModel, type UsageProject, type UsageReport, type UsageSource, type UsageTotals } from "../../../../shared/usage";
import { merge, OWN, PLAN, type FileState, type Rec } from "./parse";
import { priceRec, type Price } from "./price";

export type Source = UsageSource;
/** What a file's requests drew from: `kind` from `since` (ms) on, unknown before it. */
export interface SourceSpan { kind: Source; since?: number }

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
  /** what a file's requests drew from (a Codex file's own record decides per request: codexSource) */
  source: (f: FileState) => Source | SourceSpan;
  /** a folder TETHER_HIDE_PROJECTS (or the removed Home agent's old folder) hides */
  hidden?: (path: string) => boolean;
  /** Tether's API cost ledger: whole-session totals by Tether session id */
  ledger?: (sessionId: string) => { usd?: number; complete: boolean } | undefined;
}

function add(t: UsageTotals, r: Rec, price: Price | undefined, source: Source) {
  t.input += r[3];
  t.output += r[4];
  t.cacheRead += r[5];
  t.cacheWrite += r[6] + r[7];
  t.requests++;
  const part = t.sources[source];
  part.requests++;
  if (!price) {
    t.unpriced++;
    part.unpriced++;
    return;
  }
  t.usd += price.usd;
  t.savings += price.savings;
  part.usd += price.usd;
}

const byWorth = (a: UsageTotals, b: UsageTotals) => b.usd - a.usd || totalTokens(b) - totalTokens(a);

export function buildReport(o: ReportInput): Omit<UsageReport, "plans" | "scan"> {
  const key = dayKeyer(o.timeZone);
  const range = dayRange(key(o.now / 1000), o.days);
  const from = range[0]!, to = range[range.length - 1]!;
  // Anything in range is newer than this (a day and a half's slack covers every zone's offset).
  const since = o.now / 1000 - (o.days + 1.5) * 86_400;
  // One request, once: copies in several files merge to their largest counts, and belong to the
  // file whose session the entry names (a resumed or forked session's copy doesn't take it).
  const requests = new Map<string, { r: Rec; f: FileState }>();
  for (const [, f] of [...o.files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const r of f.recs) {
      if (r[1] < since) continue;
      const had = requests.get(r[0]);
      if (!had) {
        requests.set(r[0], { r: [...r], f });
        continue;
      }
      if (r[8] & OWN && !(had.r[8] & OWN)) had.f = f;
      merge(had.r, r);
    }
  }
  const total = emptyTotals();
  const days = new Map(range.map((day) => [day, { day, ...emptyTotals() }]));
  const models = new Map<string, UsageModel>();
  const projects = new Map<string, UsageProject>();
  const hiddenRow: UsageProject = { name: "Hidden projects", hidden: true, ...emptyTotals() };
  const sessions = new Set<string>();
  const spans = new Map<FileState, SourceSpan>();
  for (const { r, f } of requests.values()) {
    const day = days.get(key(r[1]));
    if (!day) continue;
    let span = spans.get(f);
    if (!span) {
      const got = o.source(f);
      spans.set(f, (span = typeof got === "string" ? { kind: got } : got));
    }
    let source: Source = "unknown";
    if (f.harness === "codex") source = codexSource(f, r);
    else if (f.harness === "antigravity") source = r[8] & PLAN ? "plan" : "unknown";
    else if (r[1] * 1000 >= (span.since ?? 0)) source = span.kind;
    const price = source === "provider" ? undefined : priceRec(f.harness, r, f.harness === "codex" ? f.provider : undefined);
    add(total, r, price, source);
    add(day, r, price, source);
    const mk = `${f.harness}\u0000${r[2]}`;
    let m = models.get(mk);
    if (!m) models.set(mk, (m = { harness: f.harness, model: r[2], ...emptyTotals() }));
    add(m, r, price, source);
    const path = f.project;
    let p = path && o.hidden?.(path) ? hiddenRow : projects.get(path ?? "");
    if (!p) projects.set(path ?? "", (p = path ? { path, name: basename(path) || path, ...emptyTotals() } : { name: "Unknown folder", ...emptyTotals() }));
    add(p, r, price, source);
    if (f.session) sessions.add(`${f.harness}:${f.session}`);
  }
  const ranked = [...projects.values()].sort(byWorth);
  const byProject = ranked.slice(0, TOP_PROJECTS);
  const rest = ranked.slice(TOP_PROJECTS);
  if (rest.length === 1) byProject.push(rest[0]!);
  else if (rest.length) {
    const other: UsageProject = { name: `${rest.length} other projects`, others: rest.length, ...emptyTotals() };
    for (const p of rest) addTotals(other, p);
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

/**
 * Codex: what a request drew from, by its rollout. OpenAI's API through Tether's private home is a
 * key; Azure and other providers are providers; OpenAI's own whose token count carried a plan's
 * limits is the plan; anything else isn't known.
 */
export function codexSource(f: FileState, r?: Rec): Source {
  const provider = f.provider ?? "";
  if (provider === "tether_openai") return "key";
  if (provider && provider !== "openai") return "provider";
  if (f.private) return "key";
  return provider === "openai" && r && r[8] & PLAN ? "plan" : "unknown";
}
