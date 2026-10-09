// Plan usage limits (5-hour and weekly windows) for the subscriptions the harnesses run on:
// Claude (Claude Code's /usage data, via the Agent SDK) and ChatGPT/Codex (the endpoint the Codex
// CLI uses, with pi's or the Codex CLI's login). Cached briefly; one fetch serves every browser.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderUsage, UsageReport, UsageWindow } from "../../web/src/shared/protocol";

const TTL = 120_000;
let cache: { at: number; report: UsageReport } | undefined;
let inflight: Promise<UsageReport> | undefined;

export function getUsage(force = false): Promise<UsageReport> {
  if (!force && cache && Date.now() - cache.at < TTL) return Promise.resolve(cache.report);
  inflight ??= Promise.all([claudeUsage(), codexUsage()])
    .then((providers) => {
      const report = { providers: providers.filter((p): p is ProviderUsage => !!p), fetchedAt: Date.now() };
      cache = { at: Date.now(), report };
      return report;
    })
    .finally(() => (inflight = undefined));
  return inflight;
}

/** Marks the cache stale (after a turn ends, usage has moved). */
export function usageChanged() {
  if (cache) cache.at = 0;
}

const pct = (n: number | null | undefined) => (typeof n === "number" ? Math.max(0, Math.min(100, Math.round(n))) : undefined);
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) || undefined : undefined);

async function claudeUsage(): Promise<ProviderUsage | undefined> {
  async function* idle(): AsyncGenerator<never> {
    await new Promise(() => {});
  }
  // A throwaway Claude Code process that never gets a prompt: it only answers the usage request.
  const q = query({
    prompt: idle(),
    options: { cwd: homedir(), persistSession: false, settingSources: [], tools: [] } as any,
  });
  try {
    const u: any = await Promise.race([
      (q as any).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), 20_000)),
    ]);
    if (!u.rate_limits_available || !u.rate_limits) return undefined;
    const rl = u.rate_limits;
    const windows: UsageWindow[] = [];
    if (rl.five_hour) windows.push({ label: "5h", percent: pct(rl.five_hour.utilization), resetsAt: ms(rl.five_hour.resets_at) });
    if (rl.seven_day) windows.push({ label: "Weekly", percent: pct(rl.seven_day.utilization), resetsAt: ms(rl.seven_day.resets_at) });
    for (const [k, name] of [["seven_day_opus", "Opus"], ["seven_day_sonnet", "Sonnet"]] as const)
      if (rl[k]) windows.push({ label: `Weekly · ${name}`, percent: pct(rl[k].utilization), resetsAt: ms(rl[k].resets_at) });
    for (const m of rl.model_scoped ?? [])
      windows.push({ label: `Weekly · ${m.display_name}`, percent: pct(m.utilization), resetsAt: ms(m.resets_at) });
    return { provider: "claude", label: "Claude", plan: u.subscription_type ?? undefined, windows };
  } catch (e: any) {
    return { provider: "claude", label: "Claude", windows: [], error: e?.message ?? String(e) };
  } finally {
    try {
      q.close();
    } catch {}
  }
}

/** pi's ChatGPT login, else the Codex CLI's own (~/.codex/auth.json). Both are the same account kind. */
function codexAuth(): { access: string; accountId?: string; expires?: number } | undefined {
  try {
    const pi = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"))["openai-codex"];
    if (pi?.access) return pi;
  } catch {}
  try {
    const t = JSON.parse(readFileSync(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"), "utf8")).tokens;
    if (t?.access_token) return { access: t.access_token, accountId: t.account_id };
  } catch {}
  return undefined;
}

async function codexUsage(): Promise<ProviderUsage | undefined> {
  const auth = codexAuth();
  if (!auth) return undefined;
  // pi refreshes the token whenever it uses Codex; refreshing here would race it, so an expired
  // token just means "unknown until pi runs again".
  if (auth.expires && auth.expires < Date.now())
    return { provider: "codex", label: "Codex", windows: [], error: "Login expired; it refreshes the next time pi uses Codex." };
  try {
    const r = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: { Authorization: `Bearer ${auth.access}`, "chatgpt-account-id": auth.accountId ?? "", "User-Agent": "tether" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j: any = await r.json();
    const win = (w: any, label: string): UsageWindow | undefined =>
      w ? { label, percent: pct(w.used_percent), resetsAt: w.reset_at ? w.reset_at * 1000 : undefined } : undefined;
    const label = (w: any, fallback: string) => {
      const s = w?.limit_window_seconds;
      return s === 18000 ? "5h" : s === 604800 ? "Weekly" : s ? `${Math.round(s / 3600)}h` : fallback;
    };
    const rl = j.rate_limit ?? {};
    const windows = [win(rl.primary_window, label(rl.primary_window, "5h")), win(rl.secondary_window, label(rl.secondary_window, "Weekly"))].filter(
      (w): w is UsageWindow => !!w,
    );
    return { provider: "codex", label: "Codex", plan: j.plan_type ?? undefined, windows, limited: !!rl.limit_reached };
  } catch (e: any) {
    return { provider: "codex", label: "Codex", windows: [], error: e?.message ?? String(e) };
  }
}
