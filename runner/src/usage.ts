// Plan usage limits for the subscriptions the harnesses run on: Claude (Claude Code's /usage data,
// via the Agent SDK, 5-hour and weekly windows), ChatGPT/Codex (the endpoint the Codex CLI uses,
// with pi's or the Codex CLI's login) and Kiro (its monthly credit pool, from the same
// GetUsageLimits call kiro-cli's own /usage makes). Cached briefly; one fetch serves every browser.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderUsage, UsageReport, UsageWindow } from "../../web/src/shared/protocol";
import { userHome } from "./home";

const TTL = 120_000;
let cache: { at: number; report: UsageReport } | undefined;
let inflight: Promise<UsageReport> | undefined;

export function getUsage(force = false): Promise<UsageReport> {
  if (!force && cache && Date.now() - cache.at < TTL) return Promise.resolve(withSimulated(cache.report));
  // A simulated provider isn't fetched (Claude's check spawns a process).
  inflight ??= Promise.all([simulated.claude ? undefined : claudeUsage(), simulated.codex ? undefined : codexUsage(), simulated.kiro ? undefined : kiroUsage()])
    .then((providers) => {
      const report = { providers: providers.filter((p): p is ProviderUsage => !!p), fetchedAt: Date.now() };
      cache = { at: Date.now(), report };
      return report;
    })
    .finally(() => (inflight = undefined));
  return inflight.then(withSimulated);
}

/** Dev fault injection (faults.ts, `/tether simulate-usage`): stand-in usage per provider, until cleared. */
const simulated: Partial<Record<ProviderUsage["provider"], ProviderUsage>> = {};

export function simulateUsage(provider: ProviderUsage["provider"], usage?: ProviderUsage) {
  if (usage) simulated[provider] = usage;
  else delete simulated[provider];
  cache = undefined;
}

/** The stand-in for this account, if one is set (both ChatGPT logins share Codex's). */
export function simulatedFor(account: UsageAccount): ProviderUsage | undefined {
  return simulated[account === "claude" ? "claude" : account === "kiro" ? "kiro" : "codex"];
}

function withSimulated(r: UsageReport): UsageReport {
  const sim = Object.values(simulated);
  if (!sim.length) return r;
  return { ...r, providers: [...r.providers.filter((p) => !simulated[p.provider]), ...sim] };
}

/**
 * The logins whose usage Tether can read: Claude Code's, the Codex CLI's ChatGPT login, and pi's
 * ChatGPT login (openai-codex). The two ChatGPT logins can be different accounts.
 */
export type UsageAccount = "claude" | "chatgpt:codex" | "chatgpt:pi" | "kiro";

/**
 * A fresh fetch for one account, never from the cache: what fallback checks before it marks a
 * provider exhausted on an error that only looks like a limit.
 */
export async function accountUsage(account: UsageAccount): Promise<ProviderUsage | undefined> {
  usageChanged();
  const sim = simulatedFor(account);
  if (sim) return sim;
  if (account === "claude") return claudeUsage();
  if (account === "kiro") return kiroUsage();
  const auth = account === "chatgpt:pi" ? piAuth() : codexCliAuth();
  return auth ? codexUsage(auth) : undefined;
}

/**
 * Which subscription logins are on this machine, from the files the harnesses keep (no network):
 * for suggesting a default order. Claude Code's login is in the macOS keychain there, so it counts
 * as signed in; elsewhere its credentials file or a token in the environment does. The ChatGPT
 * logins carry their account id, to tell whether pi's and the Codex CLI's are the same account.
 */
export async function signedIn(): Promise<{ claude: boolean; codex?: { accountId?: string }; pi?: { accountId?: string }; kiro?: boolean }> {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(userHome(), ".claude");
  const claude = process.platform === "darwin" || !!process.env.CLAUDE_CODE_OAUTH_TOKEN || !!process.env.ANTHROPIC_API_KEY || existsSync(join(claudeDir, ".credentials.json"));
  const codex = codexCliAuth();
  const pi = piAuth();
  return { claude, codex: codex && { accountId: codex.accountId }, pi: pi && { accountId: pi.accountId }, kiro: await kiroSignedIn() };
}

/**
 * Whether kiro-cli has a login, without holding up the runner: its store is read with a short busy
 * wait (a live kiro-cli may be writing), a few times. Undefined (unknown) when it can't be read.
 */
async function kiroSignedIn(): Promise<boolean | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return !!readKiroToken(50);
    } catch {
      await Bun.sleep(100);
    }
  }
  return undefined;
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
    options: { cwd: userHome(), persistSession: false, settingSources: [], tools: [] } as any,
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

type CodexAuth = { access: string; accountId?: string; expires?: number };

function piAuth(): CodexAuth | undefined {
  try {
    const pi = JSON.parse(readFileSync(join(userHome(), ".pi", "agent", "auth.json"), "utf8"))["openai-codex"];
    if (pi?.access) return pi;
  } catch {}
  return undefined;
}

function codexCliAuth(): CodexAuth | undefined {
  try {
    const t = JSON.parse(readFileSync(join(process.env.CODEX_HOME ?? join(userHome(), ".codex"), "auth.json"), "utf8")).tokens;
    if (t?.access_token) return { access: t.access_token, accountId: t.account_id };
  } catch {}
  return undefined;
}

/** pi's ChatGPT login, else the Codex CLI's own (~/.codex/auth.json). Both are the same account kind. */
function codexAuth(): CodexAuth | undefined {
  return piAuth() ?? codexCliAuth();
}

async function codexUsage(auth = codexAuth()): Promise<ProviderUsage | undefined> {
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

// ---------------- Kiro ----------------
// kiro-cli (Amazon Q Developer CLI lineage) keeps its login and CodeWhisperer profile in a local
// SQLite store (~/.local/share/kiro-cli/data.sqlite3). Usage is a monthly credit pool, read from
// the GetUsageLimits operation (GET https://management.{region}.kiro.dev/Get-Usage-Limits with the
// profile ARN and the login's bearer token) — the same call kiro-cli's own `/usage` makes. The
// token is read in-process and never logged. KIRO_DB and KIRO_USAGE_URL override the defaults.

type KiroAuth = { access: string; region: string; profileArn?: string };

const regionOfArn = (arn?: string) => arn?.match(/^arn:aws:codewhisperer:([a-z0-9-]+):/)?.[1];

const dbText = (v: unknown): string | undefined => (typeof v === "string" ? v : v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : undefined);

/**
 * Reads the login token and profile ARN from kiro-cli's SQLite store. The live kiro-cli writes this
 * DB (sessions, token refresh), so a reader must tolerate a busy lock: open read-only with a busy
 * timeout so queries wait out a writer instead of failing. Returns null when there's no store or
 * token (not signed in); throws only on an unexpected DB error (e.g. still locked after the wait),
 * which the caller retries.
 */
function readKiroToken(busyMs = 3000): { access: string; arn?: string; region?: string } | null {
  const path = process.env.KIRO_DB ?? join(userHome(), ".local", "share", "kiro-cli", "data.sqlite3");
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.round(busyMs)}`); // wait out the live kiro-cli's writes instead of failing
    // One token per auth method; social, Builder ID and IdC logins all land under kirocli:*:token.
    // The stored record is snake_case (access_token, profile_arn); camelCase kept as a fallback.
    let token: { access: string; arn?: string; region?: string } | undefined;
    for (const r of db.query("select value from auth_kv where key like 'kirocli:%:token'").all() as { value: unknown }[]) {
      try {
        const j: any = JSON.parse(dbText(r.value) ?? "");
        const access = j?.access_token ?? j?.accessToken;
        if (access) {
          token = { access, arn: j?.profile_arn ?? j?.profileArn, region: j?.region };
          break;
        }
      } catch {}
    }
    if (!token) return null;
    if (!token.arn)
      try {
        const prof = JSON.parse(dbText((db.query("select value from state where key = 'api.codewhisperer.profile'").get() as { value: unknown } | null)?.value) ?? "");
        if (typeof prof?.arn === "string") token.arn = prof.arn;
      } catch {}
    return token;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

/** The kiro-cli login's bearer token, region and profile ARN; undefined when not signed in. Retries a locked DB. */
async function kiroAuth(): Promise<KiroAuth | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      const t = readKiroToken();
      if (!t) return undefined;
      return { access: t.access, region: t.region || regionOfArn(t.arn) || "us-east-1", profileArn: t.arn };
    } catch (e) {
      if (attempt >= 3) throw e; // still locked after retries: let kiroUsage surface it
      await Bun.sleep(150);
    }
  }
}

/** `nextDateReset` over JSON: epoch seconds, epoch ms, or an ISO string. */
function kiroReset(v: unknown): number | undefined {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") return Date.parse(v) || undefined;
  return undefined;
}

/**
 * A GetUsageLimits response as the usage page's shape: one window per limited breakdown (its
 * `currentUsage`/`usageLimit` kept as raw amounts and as a percent), the subscription title as the
 * plan, `nextDateReset` as the reset. Exported for the test.
 */
export function parseKiroUsage(j: any): ProviderUsage {
  const resetsAt = kiroReset(j?.nextDateReset);
  const plan = j?.subscriptionInfo?.subscriptionTitle;
  const windows: UsageWindow[] = [];
  for (const b of j?.usageBreakdownList ?? []) {
    const used = b?.currentUsageWithPrecision ?? b?.currentUsage ?? 0;
    const limit = b?.usageLimitWithPrecision ?? b?.usageLimit ?? 0;
    if (!(limit > 0)) continue; // an unlimited breakdown has no percentage to show
    windows.push({ label: b?.displayNamePlural ?? b?.displayName ?? b?.resourceType ?? "Credits", percent: pct((used / limit) * 100), resetsAt, used, limit });
  }
  const limited = windows.some((w) => (w.percent ?? 0) >= 100);
  return { provider: "kiro", label: "Kiro", plan: plan && plan !== "Unknown" ? plan : undefined, windows, ...(limited ? { limited: true } : {}) };
}

async function kiroUsage(): Promise<ProviderUsage | undefined> {
  let auth: KiroAuth | undefined;
  try {
    auth = await kiroAuth();
  } catch (e: any) {
    // The DB stayed locked by the live kiro-cli; a transient error row, not a vanished provider.
    return { provider: "kiro", label: "Kiro", windows: [], error: `Couldn't read the Kiro login (busy): ${e?.message ?? e}` };
  }
  if (!auth) return undefined; // not signed in: no Kiro row on the page
  try {
    const base = process.env.KIRO_USAGE_URL ?? `https://management.${auth.region}.kiro.dev`;
    const url = `${base}/Get-Usage-Limits${auth.profileArn ? `?profileArn=${encodeURIComponent(auth.profileArn)}` : ""}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${auth.access}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return parseKiroUsage(await r.json());
  } catch (e: any) {
    return { provider: "kiro", label: "Kiro", windows: [], error: e?.message ?? String(e) };
  }
}
