// Human labels for model ids, effort levels and permission modes (SPEC §2.6: "Opus 5.5", "High").
// The runner labels what a harness lists; the browser labels whatever a session reports.

import type { Billing, ModelOption, PlanUsage, PlanWindow } from "./transcript";

const FAMILIES = ["opus", "sonnet", "haiku", "fable"];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * "claude-opus-5-5" -> "Opus 5.5", "claude-haiku-4-5-20251001" -> "Haiku 4.5", "opus" -> "Opus",
 * "claude-sonnet-5[1m]" -> "Sonnet 5 (1M)". An id it doesn't recognize comes back as it is.
 */
export function prettyModel(id: string): string {
  const m = id.match(/^(?:claude-)?([a-z]+)((?:-\d+)*)(?:-\d{8})?(\[1m\])?$/i);
  if (!m || !FAMILIES.includes(m[1]!.toLowerCase())) return id;
  const version = m[2] ? m[2].slice(1).split("-").filter((p) => p.length < 8).join(".") : "";
  return `${cap(m[1]!.toLowerCase())}${version ? ` ${version}` : ""}${m[3] ? " (1M)" : ""}`;
}

/** A model of the list, by id or by what an alias resolves to. */
export const findModel = (models: ModelOption[], id: string | undefined) => models.find((m) => m.id === id) ?? models.find((m) => m.resolved === id && m.id !== "default");

/**
 * A model's label: the harness's own name for it when the list has it (by id or by what an alias
 * resolves to), else its id made readable. "default" reads as what it runs now when known.
 */
export function modelLabel(id: string | undefined, models: ModelOption[] = [], resolved?: string): string {
  if (!id) return "Default";
  const hit = findModel(models, id);
  if (id === "default") {
    const runs = resolved ?? hit?.resolved;
    return runs ? `Default (${modelLabel(runs, models.filter((m) => m.id !== "default"))})` : "Default";
  }
  return hit?.label ?? prettyModel(id);
}

const EFFORTS: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
export const effortLabel = (e: string | undefined) => (e ? (EFFORTS[e] ?? cap(e)) : "Default");

const MODES: Record<string, string> = {
  default: "Ask first",
  acceptEdits: "Accept edits",
  plan: "Plan",
  bypassPermissions: "Bypass permissions",
  auto: "Auto",
  dontAsk: "Don't ask",
  // Codex's presets (runner/src/adapters/codex/modes.ts)
  "read-only": "Read only",
  untrusted: "Ask first",
  "full-access": "Full access",
  unknown: "Unknown",
  custom: "Custom",
};
export const permissionModeLabel = (m: string | undefined): string => {
  if (!m) return "Ask first";
  // Codex's "Approve for me": its own reviewer answers approvals.
  if (m.endsWith("@codex-reviews")) return `${permissionModeLabel(m.slice(0, -"@codex-reviews".length))} (Codex reviews)`;
  return MODES[m] ?? cap(m);
};

const tokens = (n: number) => (n >= 999_500 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
/** The header's context chip: "42%", and its tooltip "84k of 200k context". */
export const contextPercent = (c: { used: number; total: number }) => `${Math.round((c.used / c.total) * 100)}%`;
export const contextDetail = (c: { used: number; total: number }) => `${tokens(c.used)} of ${tokens(c.total)} context`;

export const resetTime = (ms: number, week = true) => new Date(ms).toLocaleString(undefined, week ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : { hour: "numeric", minute: "2-digit" });

/**
 * The header's plan chip: the 5-hour window when available, otherwise the weekly window ("Week 63%"), and both in the tooltip. A window past its
 * reset is no longer known. Nothing known: undefined.
 */
export function planChip(plan: PlanUsage | undefined, now = Date.now()): { text: string; detail: string } | undefined {
  const known = (w?: PlanWindow) => (w && (w.resetsAt === undefined || w.resetsAt > now) ? w : undefined);
  const rows = [
    { short: "5h", long: "5-hour", w: known(plan?.fiveHour), week: false },
    { short: "Week", long: "Weekly", w: known(plan?.week), week: true },
  ].filter((r) => r.w);
  if (!rows.length) return undefined;
  const top = rows[0]!;
  const detail = rows.map((r) => `${r.long} ${r.w!.percent}%${r.w!.resetsAt ? `, resets ${resetTime(r.w!.resetsAt, r.week)}` : ""}`).join(" · ");
  return { text: `${top.short} ${top.w!.percent}%`, detail };
}

const HOUR_MS = 60 * 60_000;
const ago = (ms: number) => (ms < 24 * HOUR_MS ? `${Math.floor(ms / HOUR_MS)}h ago` : `${Math.floor(ms / (24 * HOUR_MS))}d ago`);

/**
 * The billing menu's plan lines, whatever the session draws from: "Week 64% · resets Nov 5, 6:00 PM",
 * each window as last reported, its age when that's over an hour. Nothing known: no lines.
 */
export function planLines(plan: PlanUsage | undefined, now = Date.now()): string[] {
  const line = (name: string, w: PlanWindow | undefined, week: boolean) => {
    if (!w || (w.resetsAt !== undefined && w.resetsAt <= now)) return [];
    const old = w.at !== undefined && now - w.at > HOUR_MS ? ` · ${ago(now - w.at)}` : "";
    return [`${name} ${Math.round(w.percent)}%${w.resetsAt ? ` · resets ${resetTime(w.resetsAt, week)}` : ""}${old}`];
  };
  return [...line("Week", plan?.week, true), ...line("5 hours", plan?.fiveHour, false)];
}

/** A report's windows, marked with when it came. */
export function reportedAt(plan: PlanUsage, at = Date.now()): PlanUsage {
  return { ...(plan.fiveHour ? { fiveHour: { ...plan.fiveHour, at } } : {}), ...(plan.week ? { week: { ...plan.week, at } } : {}) };
}

/** The header's usage chip: what the session draws from, with the plan's limits only if it's a plan. */
export function usageChip(billing: Billing, plan: PlanUsage | undefined, now = Date.now()): { text: string; detail: string } {
  const limits = billing.kind === "plan" ? planChip(plan, now) : undefined;
  return limits ? { text: `${billing.label} · ${limits.text}`, detail: limits.detail } : { text: billing.label, detail: billing.kind === "unknown" ? "What this session draws from wasn't reported" : billing.label };
}

/** Only confirmed metered sources use the API colour. Unknown stays neutral. */
export function isApiBilling(billing: Billing | undefined): boolean {
  return billing?.kind === "apiKey" || billing?.kind === "provider";
}
