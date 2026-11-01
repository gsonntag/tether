// Only numbers, opaque report ids and fixed reason codes are persisted. Native cumulative reports replace earlier
// reports from the same epoch; distinct processes/responses add without double-counting replays.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { costReasons, reasonValue, type SessionCost, type TokenRates } from "../../shared/costs";
import { AZURE_LONG_CONTEXT, azureModelId, azureTableRates, type AzureBand, type AzurePricing } from "../../shared/azureRates";

/** `reasons`: why coverage isn't whole (earlier usage, a terminal), apart from any report's. */
interface Entry { complete: boolean; reports: Record<string, SessionCost>; reasons?: string[] }
interface Saved { version: 1; sessions: Record<string, Entry> }
const unknown = (...reasons: string[]): SessionCost => ({ estimated: true, complete: false, ...(reasons.length ? { reasons } : {}) });
const validUsd = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

export class CostLedger {
  private data: Saved = { version: 1, sessions: Object.create(null) };
  private unreadable = false;
  constructor(private file?: string) {
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      if (saved.version !== 1 || !saved.sessions || typeof saved.sessions !== "object" || Array.isArray(saved.sessions)) throw new Error();
      for (const entry of Object.values(saved.sessions) as Entry[]) {
        if (typeof entry.complete !== "boolean" || !entry.reports || typeof entry.reports !== "object" || Array.isArray(entry.reports)) throw new Error();
        for (const report of Object.values(entry.reports)) if (!validReport(report)) throw new Error();
      }
      const sessions = Object.create(null);
      for (const [id, entry] of Object.entries(saved.sessions) as [string, Entry][]) {
        const reasons = costReasons(entry.reasons);
        sessions[id] = { complete: entry.complete, reports: Object.assign(Object.create(null), entry.reports), ...(reasons.length ? { reasons } : {}) };
      }
      this.data = { version: 1, sessions };
    } catch (e: any) { if (e?.code !== "ENOENT") this.unreadable = true; }
  }
  has(sessionId: string): boolean { return Object.hasOwn(this.data.sessions, sessionId); }
  /**
   * `complete` is true only when all API usage is tracked from this session's first API turn: Tether
   * knows what it spent on an API before (nothing, or what this ledger holds). Otherwise `reason` says why.
   */
  begin(sessionId: string, complete: boolean, reason = "earlier-usage"): SessionCost {
    if (!Object.hasOwn(this.data.sessions, sessionId)) {
      const whole = complete && !this.unreadable;
      this.data.sessions[sessionId] = { complete: whole, reports: Object.create(null), ...(whole ? {} : { reasons: costReasons([this.unreadable ? "earlier-usage" : reason]) }) };
      try { this.save(); } catch (error) { delete this.data.sessions[sessionId]; throw error; }
    }
    return this.get(sessionId);
  }
  report(sessionId: string, reportId: string, report: SessionCost): SessionCost {
    if (!reportId || !validReport(report)) throw new Error("Invalid API cost report.");
    // A report by itself cannot prove that earlier usage wasn't lost.
    const hadSession = Object.hasOwn(this.data.sessions, sessionId);
    if (!hadSession) this.data.sessions[sessionId] = { complete: false, reports: Object.create(null), reasons: ["earlier-usage"] };
    // Invalid cumulative reports must not replace a previous valid total with a lower number.
    const previous = this.data.sessions[sessionId]!.reports[reportId];
    if (report.usd === undefined && previous && validUsd(previous.usd)) report = { ...report, usd: previous.usd };
    if (previous?.complete && report.complete && validUsd(previous.usd) && validUsd(report.usd) && report.usd < previous.usd) {
      report = { ...report, usd: previous.usd };
    }
    this.data.sessions[sessionId]!.reports[reportId] = { ...(validUsd(report.usd) ? { usd: report.usd } : {}), estimated: report.estimated, complete: report.complete, ...codes(report) };
    try { this.save(); } catch (error) {
      if (previous) this.data.sessions[sessionId]!.reports[reportId] = previous;
      else delete this.data.sessions[sessionId]!.reports[reportId];
      if (!hadSession) delete this.data.sessions[sessionId];
      throw error;
    }
    return this.get(sessionId);
  }
  /** A thread taking a session's place starts from what the session had spent. The same id replaces. */
  carry(from: string, to: string): SessionCost | undefined {
    if (!Object.hasOwn(this.data.sessions, from)) return undefined; // plans and unmetered sessions
    const prior = this.get(from);
    if (!Object.hasOwn(this.data.sessions, to)) this.begin(to, true);
    return this.report(to, `carried:${from}`, prior);
  }
  /** Usage Tether can't see from here on (a terminal's), or before (`earlier-usage`): coverage stops being whole. */
  markUnknown(sessionId: string, reason = "terminal"): SessionCost {
    const hadSession = Object.hasOwn(this.data.sessions, sessionId);
    if (!hadSession) this.data.sessions[sessionId] = { complete: false, reports: Object.create(null) };
    const entry = this.data.sessions[sessionId]!;
    const was = { complete: entry.complete, reasons: entry.reasons };
    entry.complete = false;
    entry.reasons = costReasons([...(entry.reasons ?? []), reason]);
    try { this.save(); } catch (error) {
      if (hadSession) Object.assign(entry, was);
      else delete this.data.sessions[sessionId];
      throw error;
    }
    return this.get(sessionId);
  }
  get(sessionId: string): SessionCost {
    const entry = Object.hasOwn(this.data.sessions, sessionId) ? this.data.sessions[sessionId] : undefined;
    // Nothing recorded for it: whatever it spent, Tether didn't see.
    if (!entry) return unknown("earlier-usage");
    const reports = Object.values(entry.reports);
    const complete = entry.complete && reports.every((r) => r.complete && validUsd(r.usd));
    const known = reports.filter((r) => validUsd(r.usd));
    const usd = known.reduce((sum, report) => sum + report.usd!, 0);
    // Every gap has a code. Files from before entry reasons: a gap in coverage was always usage
    // Tether didn't see, and a report that wasn't whole said nothing more than that it had no usage.
    const gap = entry.complete ? [] : entry.reasons?.length ? entry.reasons : ["earlier-usage"];
    const missing = reports.flatMap((r) => r.reasons?.length ? r.reasons : r.complete && validUsd(r.usd) ? [] : ["no-usage"]);
    return { ...(known.length || complete ? { usd } : {}), estimated: reports.some((r) => r.estimated), complete, ...codes({ reasons: [...gap, ...missing], notes: reports.flatMap((r) => r.notes ?? []) }) };
  }
  private save() {
    if (!this.file) return;
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(temp, JSON.stringify(this.data) + "\n", { mode: 0o600, flag: "wx" });
      chmodSync(temp, 0o600);
      renameSync(temp, this.file);
    } catch { throw new Error("Couldn't save the session's API cost totals."); }
  }
}
function codes(report: Pick<SessionCost, "reasons" | "notes">) {
  const reasons = costReasons(report.reasons), notes = costReasons(report.notes);
  return { ...(reasons.length ? { reasons } : {}), ...(notes.length ? { notes } : {}) };
}
function validReport(value: any): value is SessionCost {
  return !!value && typeof value.estimated === "boolean" && typeof value.complete === "boolean" && (value.usd === undefined || validUsd(value.usd)) && (!value.complete || validUsd(value.usd));
}

/** Published standard USD rates, verified 2026-10-31. No alias/provider/tier inference.
 * https://developers.openai.com/api/docs/pricing
 * https://developers.openai.com/api/docs/models/gpt-6-luna
 * Long context, other service tiers, non-token tool fees and contract prices are not guessed.
 * No dated snapshot of these models is published, so none prices here.
 */
const STANDARD_OPENAI: Record<string, TokenRates> = {
  "gpt-6-luna": { input: 0.10, output: 0.50, cached: 0.01 },
  "gpt-6.1-sol": { input: 2, output: 10, cached: 0.10 },
  "gpt-6.1-terra": { input: 1, output: 5, cached: 0.05 },
  "gpt-6-astra": { input: 10, output: 50, cached: 1 },
};
export interface TokenUsage { input: number; output: number; cached: number; write30m?: number; write12h?: number }
/** OpenAI's API at its published Standard rates. */
export function estimateTokenCost(model: string, usage: TokenUsage, opts: { tier?: string } = {}): SessionCost {
  const { input, output, cached, write30m, write12h } = usage;
  if (!validUsage(usage)) return unknown("no-usage");
  if (!["default", "standard"].includes(opts.tier ?? "")) return unknown(`tier:${reasonValue(opts.tier ?? "missing")}`);
  if (input > 272_000) return unknown("long-context");
  const rates = STANDARD_OPENAI[model];
  if (!rates) return unknown(`model:${reasonValue(model)}`);
  if (write30m === undefined || write12h === undefined) return unknown("no-cache-ttl");
  const ordinary = input - cached - write30m - write12h;
  const usd = (ordinary * rates.input + cached * rates.cached + write30m * rates.input * 1.25 + write12h * rates.input * 2.5 + output * rates.output) / 1_000_000;
  return validUsd(usd) ? { usd, estimated: true, complete: true } : unknown("no-usage");
}
const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
function validUsage({ input, output, cached, write30m, write12h }: TokenUsage) {
  return [input, output, cached].every(count) && (write30m === undefined || count(write30m)) && (write12h === undefined || count(write12h)) &&
    cached + (write30m ?? 0) + (write12h ?? 0) <= input;
}

/**
 * One Azure request's price. The deployment's own rates (Override) price short requests only: one
 * set of numbers says nothing of long context. Otherwise its model and type find Tether's dated table
 * (`shared/azureRates.ts`): ≤ 272K input tokens short, else long. Azure lists one write rate, so
 * writes are priced by their total, with or without a lifetime breakdown, where a rate exists.
 */
export function estimateAzureCost(pricing: AzurePricing | undefined, usage: { input: number; output: number; cached: number; writes: number }, tier?: unknown): SessionCost {
  const { input, output, cached, writes } = usage;
  if (!validUsage({ input, output, cached, write30m: writes, write12h: 0 })) return unknown("no-usage");
  if (!(tier === undefined || tier === null || tier === "" || tier === "default" || tier === "standard" || tier === "auto")) return unknown(`tier:${reasonValue(tier)}`);
  const long = input > AZURE_LONG_CONTEXT;
  let band: AzureBand | undefined;
  const notes: string[] = [];
  if (pricing?.rates) {
    if (long) return unknown("long-context");
    band = pricing.rates;
  } else {
    if (!pricing?.model?.trim()) return unknown("model:none");
    if (!azureModelId(pricing.model)) return unknown(`model:${reasonValue(pricing.model.trim().toLowerCase())}`);
    if (pricing.type === "regional") return unknown("type:regional");
    const table = azureTableRates(pricing.model, pricing.type ?? "global");
    if (!table) return unknown(`type:${reasonValue(pricing.type)}`);
    band = long ? table.long : table.short;
    if (!band) return unknown("long-context");
    notes.push("azure-table");
  }
  if (writes > 0 && band.cacheWrite === undefined) return unknown("no-write-rate");
  const usd = ((input - cached - writes) * band.input + cached * band.cached + writes * (band.cacheWrite ?? 0) + output * band.output) / 1_000_000;
  return validUsd(usd) ? { usd, estimated: true, complete: true, ...(notes.length ? { notes } : {}) } : unknown("no-usage");
}

const FEE_TOOLS = ["web_search_call", "image_generation_call", "file_search_call", "code_interpreter_call"];
const parsed = (text?: string) => {
  try { const json = JSON.parse(text ?? ""); return json && typeof json === "object" ? json : undefined; } catch { return undefined; }
};

/**
 * One finished response's price. `request` is its body as sent (undefined if it wasn't readable).
 * https://developers.openai.com/api/docs/guides/prompt-caching
 * https://developers.openai.com/api/reference/resources/responses/methods/create
 * The reference promises a response's service_tier only when the request set one, and Codex doesn't,
 * so a request that left the tier to the default is Standard unless the response says otherwise. The
 * cache guide promises a write breakdown on models with prompt_cache_options, the reference and
 * Codex know only the total: a total without one is at the 30-minute default, unless the request
 * chose a lifetime, when it's the cheaper rate, a lower bound and not complete. `notes` keep what a
 * priced response left to these rules: that's what shows the real API's shape.
 */
export function priceResponse(source: "openai" | "azure", response: any, opts: { pricing?: AzurePricing; request?: string } = {}): SessionCost {
  const usage = response?.usage;
  const details = usage?.input_tokens_details;
  const fees = response?.output?.some?.((item: any) => FEE_TOOLS.includes(item?.type));
  const done = (cost: SessionCost, notes: string[] = [], lowerBound = false): SessionCost => {
    const reasons = [...(cost.reasons ?? []), ...(lowerBound ? ["no-cache-ttl"] : []), ...(fees ? ["tool-fee"] : [])];
    const kept = cost.usd === undefined ? [] : [...notes.filter((note) => !lowerBound || note !== "no-cache-ttl"), ...(cost.notes ?? [])];
    return { ...cost, complete: cost.complete && !lowerBound && !fees, ...(reasons.length ? { reasons } : {}), ...(kept.length ? { notes: kept } : {}) };
  };
  const { input_tokens: input, output_tokens: output } = usage ?? {};
  const cached = details?.cached_tokens;
  if (typeof input !== "number" || typeof output !== "number" || typeof cached !== "number") return done(unknown("no-usage"));

  const total = details.cache_write_tokens;
  const write30m = details.cache_write_tokens_details?.ttl_30m_tokens;
  const write12h = details.cache_write_tokens_details?.ttl_12h_tokens;
  const breakdown = Number.isSafeInteger(write30m) && Number.isSafeInteger(write12h) && (total === undefined || write30m + write12h === total);

  if (source === "azure") {
    // One write rate: the total, else the breakdown's sum; none reported is none written.
    const writes = total ?? (breakdown ? write30m + write12h : details.cache_write_tokens_details == null ? 0 : undefined);
    return done(estimateAzureCost(opts.pricing, { input, output, cached, writes }, response?.service_tier));
  }

  const request = parsed(opts.request);
  const notes: string[] = [];
  let writes = { write30m: 0, write12h: 0 };
  let lowerBound = false;
  if (total !== 0 && breakdown) writes = { write30m, write12h };
  else if (total !== 0) {
    notes.push("no-cache-ttl");
    // Keys aren't escaped in JSON and text in strings is, so this finds only a real ttl.
    const lifetimeChosen = !request || /"ttl"\s*:\s*"(?!30m")/.test(opts.request!);
    // No count at all: its tokens stay at the ordinary input rate, below any write rate.
    if (Number.isSafeInteger(total)) writes = { write30m: total, write12h: 0 };
    lowerBound = !Number.isSafeInteger(total) || lifetimeChosen || details.cache_write_tokens_details != null;
  }

  let tier = response?.service_tier;
  if (tier === undefined || tier === null || tier === "" || tier === "auto") {
    const asked = request?.service_tier;
    if (request && (asked === undefined || asked === null || asked === "auto" || asked === "default")) {
      notes.push(`tier:${reasonValue(tier || "missing")}`);
      tier = "default";
    } else tier = asked ?? (tier || "missing");
  }
  const cost = estimateTokenCost(response?.model, { input, output, cached, ...writes }, { tier });
  return done(cost, notes, cost.usd !== undefined && lowerBound);
}
