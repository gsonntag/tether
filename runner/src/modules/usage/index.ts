// Settings → Usage (SPEC §10 Usage): the `usage` op. Tokens and API-price estimates for the last
// 30 days, read from the harness stores themselves (scan.ts), so CLI sessions count as Tether's do.
// Nothing is read until the page first asks: then the scan runs in the background (again when asked
// and the last is over a minute old) and the op answers at once with what's read so far.

import { join } from "node:path";
import { USAGE_DAYS_MAX, validTimeZone, type UsageReport } from "../../../../shared/usage";
import type { HarnessId } from "../../../../shared/transcript";
import type { Adapter } from "../../core/adapter";
import type { Module, ModuleContext } from "..";
import type { FileState } from "./parse";
import { buildReport, type Source, type SourceSpan } from "./report";
import { UsageScanner, type UsageRoot } from "./scan";

const FRESH_MS = 60_000;
const PLAN_LABELS: Record<HarnessId, string> = { claude: "Claude plan", codex: "ChatGPT plan", antigravity: "Google AI plan" };

/** Every adapter's session logs. */
export const usageRoots = (adapters: Adapter[]): UsageRoot[] => adapters.flatMap((a) => (a.usageStores?.() ?? []).map((s) => ({ harness: a.id, ...s })));

/**
 * Claude: Tether records only a session's latest start, what it drew from and when. That source holds
 * from its start on; what came before isn't known (the session may have been on another).
 */
export function claudeSource(f: FileState, latestStart: Adapter["latestStart"]): SourceSpan {
  const start = f.session ? latestStart?.(f.session) : undefined;
  // An auth token (ANTHROPIC_AUTH_TOKEN) goes to a gateway or proxy, whose prices aren't Anthropic's.
  const kind: Source = start?.kind === "plan" ? "plan" : start?.kind === "apiKey" && start.label !== "Anthropic auth token" ? "key" : start?.kind === "provider" || start?.kind === "apiKey" ? "provider" : "unknown";
  return kind === "unknown" ? { kind } : { kind, since: start!.at };
}

/** The op over a scanner (exported for tests). */
export async function usageReport(ctx: Pick<ModuleContext, "sessions" | "apiCost" | "hiddenFolder">, scanner: UsageScanner, a: { days?: number; timeZone?: string; refresh?: boolean } | undefined, now = Date.now()): Promise<UsageReport> {
  const days = Math.min(USAGE_DAYS_MAX, Math.max(1, Math.floor(Number(a?.days) || USAGE_DAYS_MAX)));
  if (!scanner.scanning && (a?.refresh === true || !scanner.last || now - scanner.last.at > FRESH_MS)) scanner.scan().catch(() => {});
  const adapters = ctx.sessions.adapters();
  const claude = adapters.find((x) => x.id === "claude");
  const report = buildReport({
    files: scanner.files,
    days,
    timeZone: validTimeZone(a?.timeZone),
    now,
    // Codex's own records decide per request (report.ts codexSource).
    source: (f) => (f.harness === "claude" ? claudeSource(f, claude?.latestStart) : "unknown"),
    hidden: (path) => !!ctx.hiddenFolder?.(path),
    ledger: (id) => ctx.apiCost?.(id),
  });
  const plans: UsageReport["plans"] = [];
  for (const adapter of adapters) {
    const plan = await adapter.planUsage?.().catch(() => undefined);
    if (plan && (plan.fiveHour || plan.week || (plan.pools && plan.pools.length > 0))) plans.push({ harness: adapter.id, label: PLAN_LABELS[adapter.id] ?? adapter.id, plan });
  }
  return {
    ...report,
    plans,
    scan: { running: scanner.scanning, files: scanner.progress.files, done: scanner.progress.done, ...(scanner.last ? { at: scanner.last.at, ms: scanner.last.ms } : {}), errors: scanner.errors, ...(scanner.skipped ? { skipped: scanner.skipped } : {}) },
  };
}

export const usageModule: Module = {
  name: "usage",
  start(ctx) {
    const scanner = new UsageScanner({ roots: () => usageRoots(ctx.sessions.adapters()), cacheFile: join(ctx.dataDir, "cache.json"), log: ctx.log });
    ctx.ops.register("usage", (a) => usageReport(ctx, scanner, a));
    return () => scanner.stop();
  },
};
