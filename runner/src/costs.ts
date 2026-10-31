// Only numbers and opaque report ids are persisted. Native cumulative reports replace earlier
// reports from the same epoch; distinct processes/responses add without double-counting replays.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validRates, type SessionCost, type TokenRates } from "../../shared/costs";

interface Entry { complete: boolean; reports: Record<string, SessionCost> }
interface Saved { version: 1; sessions: Record<string, Entry> }
const unknown = (): SessionCost => ({ estimated: true, complete: false });
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
        sessions[id] = { complete: entry.complete, reports: Object.assign(Object.create(null), entry.reports) };
      }
      this.data = { version: 1, sessions };
    } catch (e: any) { if (e?.code !== "ENOENT") this.unreadable = true; }
  }
  /** `complete` is true only when all API usage is tracked from this session's first API turn. */
  begin(sessionId: string, complete: boolean): SessionCost {
    if (!Object.hasOwn(this.data.sessions, sessionId)) {
      this.data.sessions[sessionId] = { complete: complete && !this.unreadable, reports: Object.create(null) };
      try { this.save(); } catch (error) { delete this.data.sessions[sessionId]; throw error; }
    }
    return this.get(sessionId);
  }
  report(sessionId: string, reportId: string, report: SessionCost): SessionCost {
    if (!reportId || !validReport(report)) throw new Error("Invalid API cost report.");
    // A report by itself cannot prove that earlier usage wasn't lost.
    const hadSession = Object.hasOwn(this.data.sessions, sessionId);
    if (!hadSession) this.data.sessions[sessionId] = { complete: false, reports: Object.create(null) };
    // Invalid cumulative reports must not replace a previous valid total with a lower number.
    const previous = this.data.sessions[sessionId]!.reports[reportId];
    if (previous?.complete && report.complete && validUsd(previous.usd) && validUsd(report.usd) && report.usd < previous.usd) {
      report = { ...report, usd: previous.usd };
    }
    this.data.sessions[sessionId]!.reports[reportId] = { ...(validUsd(report.usd) ? { usd: report.usd } : {}), estimated: report.estimated, complete: report.complete };
    try { this.save(); } catch (error) {
      if (previous) this.data.sessions[sessionId]!.reports[reportId] = previous;
      else delete this.data.sessions[sessionId]!.reports[reportId];
      if (!hadSession) delete this.data.sessions[sessionId];
      throw error;
    }
    return this.get(sessionId);
  }
  markUnknown(sessionId: string): SessionCost {
    const hadSession = Object.hasOwn(this.data.sessions, sessionId);
    if (!hadSession) this.data.sessions[sessionId] = { complete: false, reports: Object.create(null) };
    const wasComplete = this.data.sessions[sessionId]!.complete;
    this.data.sessions[sessionId]!.complete = false;
    try { this.save(); } catch (error) {
      if (hadSession) this.data.sessions[sessionId]!.complete = wasComplete;
      else delete this.data.sessions[sessionId];
      throw error;
    }
    return this.get(sessionId);
  }
  get(sessionId: string): SessionCost {
    const entry = Object.hasOwn(this.data.sessions, sessionId) ? this.data.sessions[sessionId] : undefined;
    if (!entry) return unknown();
    const reports = Object.values(entry.reports);
    const complete = entry.complete && reports.every((r) => r.complete && validUsd(r.usd));
    const known = reports.filter((r) => validUsd(r.usd));
    const usd = known.reduce((sum, report) => sum + report.usd!, 0);
    return { ...(known.length || complete ? { usd } : {}), estimated: reports.some((r) => r.estimated), complete };
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
function validReport(value: any): value is SessionCost {
  return !!value && typeof value.estimated === "boolean" && typeof value.complete === "boolean" && (value.usd === undefined || validUsd(value.usd)) && (!value.complete || validUsd(value.usd));
}

/** Published standard USD rates, verified 2026-10-31. No alias/provider/tier inference.
 * https://developers.openai.com/api/docs/pricing
 * https://developers.openai.com/api/docs/models/gpt-6-luna
 * Long context, unknown service tiers, non-token tool fees and contract prices are not guessed.
 */
const STANDARD_OPENAI: Record<string, TokenRates> = {
  "gpt-6-luna": { input: 0.10, output: 0.50, cached: 0.01 },
  "gpt-6.1-sol": { input: 2, output: 10, cached: 0.10 },
  "gpt-6.1-terra": { input: 1, output: 5, cached: 0.05 },
  "gpt-6-astra": { input: 10, output: 50, cached: 1 },
};
export interface TokenUsage { input: number; output: number; cached: number; write30m?: number; write12h?: number }
export function estimateTokenCost(source: "openai" | "azure", model: string, usage: TokenUsage, opts: { rates?: TokenRates; tier?: string } = {}): SessionCost {
  const { input, output, cached, write30m, write12h } = usage;
  if (![input, output, cached].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      (write30m !== undefined && (!Number.isSafeInteger(write30m) || write30m < 0)) ||
      (write12h !== undefined && (!Number.isSafeInteger(write12h) || write12h < 0)) ||
      cached + (write30m ?? 0) + (write12h ?? 0) > input) return unknown();
  // These explicit rates apply to this configured deployment. Azure prices can differ by region,
  // deployment and contract, so an OpenAI model name never supplies Azure rates.
  const supplied = opts.rates && validRates(opts.rates) ? opts.rates : undefined;
  const standard = ["default", "standard"].includes(opts.tier ?? "");
  const rates = supplied ?? (source === "openai" && standard && input <= 272_000 ? STANDARD_OPENAI[model] : undefined);
  if (!rates) return unknown();
  const hasWrites = write30m !== undefined && write12h !== undefined;
  const totalWrites = (write30m ?? 0) + (write12h ?? 0);
  if (totalWrites > 0 && !hasWrites) return unknown();
  if (totalWrites > 0 && source === "azure") return unknown();
  if (source === "openai" && !supplied && !hasWrites) return unknown();
  const ordinary = input - cached - totalWrites;
  const writeRate30m = rates.input * 1.25;
  const writeRate12h = rates.input * 2.5;
  const usd = (ordinary * rates.input + cached * rates.cached + (write30m ?? 0) * writeRate30m + (write12h ?? 0) * writeRate12h + output * rates.output) / 1_000_000;
  return validUsd(usd) ? { usd, estimated: true, complete: true } : unknown();
}
