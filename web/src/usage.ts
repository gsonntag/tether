// Settings → Usage's formatting and chart geometry (components/UsageSettings.tsx).

import { dollars } from "../../shared/costs";
import { prettyModel } from "../../shared/labels";
import type { HarnessId } from "../../shared/transcript";
import type { UsageReport, UsageTokens, UsageTotals } from "../../shared/usage";

/** "950", "12k", "3.4M", "8.7B". */
export function fmtTokens(n: number): string {
  const r = (v: number, unit: string) => `${v >= 100 ? Math.round(v) : +v.toFixed(1)}${unit}`;
  if (n >= 999_500_000) return r(n / 1e9, "B");
  if (n >= 999_500) return r(n / 1e6, "M");
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${Math.round(n)}`;
}

/** A row's API price: "$12.34", "no price" when none of it is priced, a "+" when part of it isn't. */
export function fmtPrice(t: Pick<UsageTotals, "usd" | "requests" | "unpriced">): string {
  if (t.requests > 0 && t.unpriced === t.requests) return "no price";
  return `${dollars(t.usd)}${t.unpriced > 0 ? "+" : ""}`;
}
/** A part of a row's price (plan, key): blank when the row has nothing priced. */
export const fmtPart = (usd: number, t: Pick<UsageTotals, "requests" | "unpriced">) => (t.requests > 0 && t.unpriced === t.requests ? "—" : dollars(usd));

export const SERIES: { key: keyof UsageTokens; label: string }[] = [
  { key: "input", label: "Input" },
  { key: "output", label: "Output" },
  { key: "cacheWrite", label: "Cache write" },
  { key: "cacheRead", label: "Cache read" },
];

/** A round axis top at or above `v`: 1, 2 or 5 times a power of ten. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= v)!;
}

export type Metric = "tokens" | "usd";
export interface Bar { day: string; total: number; segments: { key: string; y: number; h: number }[] }

/** Each day's bar, stacked bottom-up (tokens: by kind; dollars: one), in a chart `height` tall with its top at `max`. */
export function bars(days: (UsageTokens & { day: string; usd: number })[], metric: Metric, height: number): { max: number; bars: Bar[] } {
  const value = (d: UsageTokens & { usd: number }) => (metric === "usd" ? d.usd : SERIES.reduce((n, s) => n + d[s.key], 0));
  const max = niceMax(Math.max(0, ...days.map(value)));
  return {
    max,
    bars: days.map((d) => {
      let y = height;
      const parts = metric === "usd" ? [{ key: "usd", v: d.usd }] : SERIES.map((s) => ({ key: s.key, v: d[s.key] }));
      const segments = parts.filter((p) => p.v > 0).map((p) => {
        const h = (p.v / max) * height;
        y -= h;
        return { key: p.key, y, h };
      });
      return { day: d.day, total: value(d), segments };
    }),
  };
}

/** "Nov 17" for a YYYY-MM-DD day (a calendar day: no zone shifts it). */
export function dayLabel(day: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }): string {
  const t = Date.parse(`${day}T12:00:00Z`);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" }) : day;
}

/** "Claude · Opus 5.5"; a dated id keeps its date, so it doesn't read as the same row twice. */
export function modelName(harness: HarnessId, model: string): string {
  const date = model.match(/-(\d{8})$/)?.[1];
  return `${harness === "claude" ? "Claude" : "Codex"} · ${prettyModel(model)}${date && prettyModel(model) !== model ? ` (${date})` : ""}`;
}

/** The status beside the range: reading (with progress), else when it was read. */
export function scanLine(scan: UsageReport["scan"], now: number): string {
  if (scan.running) return scan.files ? `Reading session logs… ${scan.done.toLocaleString()} of ${scan.files.toLocaleString()} files` : "Reading session logs…";
  if (!scan.at) return "";
  const ago = Math.max(0, now - scan.at);
  const when = ago < 60_000 ? "just now" : ago < 3_600_000 ? `${Math.floor(ago / 60_000)} min ago` : `${Math.floor(ago / 3_600_000)} h ago`;
  return `Read ${when}${scan.errors ? ` · ${scan.errors} file${scan.errors === 1 ? "" : "s"} couldn't be read` : ""}`;
}

/** The browser's zone, for the runner's day buckets. */
export const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};
