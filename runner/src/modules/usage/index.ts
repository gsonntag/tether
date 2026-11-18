// Settings → Usage (SPEC §10 Usage): the `usage` op. Tokens and API-price estimates for the last
// 30 days, read from the harness stores themselves (scan.ts), so CLI sessions count as Tether's do.
// The scan runs in the background (once soon after start, then when asked and the last is over a
// minute old) and the op answers at once with what's read so far.

import { join } from "node:path";
import { USAGE_DAYS_MAX, validTimeZone, type UsageReport } from "../../../../shared/usage";
import type { HarnessId } from "../../../../shared/transcript";
import { keptStart } from "../../adapters/claude/context";
import { projectsDir } from "../../adapters/claude/paths";
import { CODEX_HOME } from "../../adapters/codex/rpc";
import { CostLedger } from "../../costs";
import { hidePattern } from "../../core/sessions";
import { DATA_DIR } from "../../credentials";
import type { Module } from "..";
import type { FileState } from "./parse";
import { buildReport, codexSource, type Source, type SourceSpan } from "./report";
import { UsageScanner, type UsageRoot } from "./scan";

const FRESH_MS = 60_000;
const FIRST_SCAN_MS = 30_000;
const PLAN_LABELS: Record<HarnessId, string> = { claude: "Claude plan", codex: "ChatGPT plan" };

export const usageRoots = (): UsageRoot[] => [
  { harness: "claude", dir: projectsDir() },
  { harness: "codex", dir: join(CODEX_HOME, "sessions") },
  { harness: "codex", dir: join(CODEX_HOME, "archived_sessions") },
  { harness: "codex", dir: join(DATA_DIR, "codex-keys"), private: true },
];

/**
 * Claude: Tether records only a session's latest start (what it drew from, and when). A session
 * Tether never metered on a key (no ledger entry) whose latest start was the plan was on the plan
 * throughout, as far as Tether knows. Otherwise the latest start's source holds from that start on,
 * and what came before is unknown: it may have changed.
 */
export function claudeSource(f: FileState, inLedger: (id: string) => boolean): SourceSpan {
  const start = f.session ? keptStart(f.session) : undefined;
  const kind: Source = start?.kind === "plan" ? "plan" : start?.kind === "apiKey" || start?.kind === "provider" ? "key" : "unknown";
  if (kind === "unknown") return { kind };
  if (kind === "plan" && !inLedger(`claude:${f.session}`)) return { kind };
  return { kind, since: start!.at };
}

export const usageModule: Module = {
  name: "usage",
  start(ctx) {
    const scanner = new UsageScanner({ roots: usageRoots, cacheFile: join(ctx.dataDir, "cache.json"), log: ctx.log });
    const hide = hidePattern([process.env.TETHER_HIDE_PROJECTS, ctx.homeFolder].filter(Boolean).join(","));
    const scan = () => {
      void scanner.scan().then(() => ctx.log(`scanned ${scanner.progress.files} files in ${scanner.last?.ms} ms`), (e) => ctx.log(`scan failed: ${e?.message ?? e}`));
    };
    const first = setTimeout(scan, FIRST_SCAN_MS);
    (first as any).unref?.();

    ctx.ops.register("usage", async (a): Promise<UsageReport> => {
      const days = Math.min(USAGE_DAYS_MAX, Math.max(1, Math.floor(Number(a?.days) || USAGE_DAYS_MAX)));
      if (!scanner.scanning && (a?.refresh === true || !scanner.last || Date.now() - scanner.last.at > FRESH_MS)) scan();
      const ledger = new CostLedger(join(DATA_DIR, "costs.json"));
      const inLedger = (id: string) => ledger.has(id);
      const report = buildReport({
        files: scanner.files,
        days,
        timeZone: validTimeZone(a?.timeZone),
        now: Date.now(),
        source: (f) => (f.harness === "claude" ? claudeSource(f, inLedger) : codexSource(f)),
        hidden: (path) => !!hide?.test(path),
        ledger: (id) => (inLedger(id) ? ledger.get(id) : undefined),
      });
      const plans: UsageReport["plans"] = [];
      for (const adapter of ctx.sessions.adapters()) {
        const plan = await adapter.planUsage?.().catch(() => undefined);
        if (plan && (plan.fiveHour || plan.week)) plans.push({ harness: adapter.id, label: PLAN_LABELS[adapter.id] ?? adapter.id, plan });
      }
      return {
        ...report,
        plans,
        scan: { running: scanner.scanning, files: scanner.progress.files, done: scanner.progress.done, ...(scanner.last ? { at: scanner.last.at, ms: scanner.last.ms } : {}), errors: scanner.errors },
      };
    });
    return () => clearTimeout(first);
  },
};
