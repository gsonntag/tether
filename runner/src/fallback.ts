// Quota-aware fallback along a session's chain, shared by every harness (the chain is a copy of
// the default order, defaultOrder.ts, or one the session set itself).
//
// Policy (agreed with the user, docs/harness-platform.md "Phase 1"):
//  - a provider counts as exhausted only on a definite signal: the harness's own structured limit
//    error (Claude's rejected rate_limit_event, Codex's usageLimitExceeded, Antigravity's
//    "Individual quota reached … Resets in …"), or error text that looks like a limit *and* a
//    fresh usage fetch for that account showing a window at 100%. Then it is marked exhausted
//    until its reset and the session moves down the chain;
//  - entries whose account Tether can't check never switch on their own: the error shows with a
//    "Continue on <next>" action instead (and so does any other error while a chain is set);
//  - rate limited / overloaded (transient): stay on the model and retry with backoff, forever;
//  - before every new turn, go back to the earliest model in the chain whose provider has reset;
//  - everything exhausted: wait for the earliest reset, then continue.
// No pre-emptive switching near a limit: a threshold setting is a possible later improvement.

import { parseEntry, usageProvider, type ChainEntry, type HarnessId, type ProviderUsage } from "../../web/src/shared/protocol";
import { config, saveConfig } from "./config";
import { canCheckUsage, credentialUsage, entryAvailable } from "./credentials/registry";
import { accountUsage, type UsageAccount } from "./usage";

export type ErrorKind = "quota" | "rate_limit" | "other";

export interface Classified {
  /** "quota" from classify() only means "possibly a limit": it is checked before anything moves */
  kind: ErrorKind;
  resetAt?: number;
  /** a structured limit signal from the harness itself: no usage check needed */
  definite?: boolean;
}

const QUOTA = /quota|usage limit|insufficient_quota|exceeded your current|limit (has been )?reached|out of credits|credit balance|plan limit|weekly limit|5-hour limit|resets? (at|in)/i;
const RATE = /\b429\b|rate.?limit|too many requests|overloaded|\b529\b|\b503\b|try again (later|in)|capacity/i;

export function classify(text: string | undefined, status?: number | null): Classified {
  const s = text ?? "";
  if (QUOTA.test(s)) return { kind: "quota", resetAt: parseReset(s) };
  if (status === 429 || status === 529 || RATE.test(s)) return { kind: "rate_limit", resetAt: parseReset(s) };
  return { kind: "other" };
}

/** Billing/credit errors: retrying won't help even when they come as a 429. */
const HARD = /insufficient_quota|exceeded your current quota|out of credits|credit balance|billing/i;

/**
 * Whether an unconfirmed "possible limit" is really a transient rate limit: a 429/529/503, or
 * rate-limit wording, e.g. OpenAI's "Rate limit reached for gpt-5 … try again in 1.2s" or Gemini's
 * per-minute "Quota exceeded … RESOURCE_EXHAUSTED". Those back off on the same model.
 */
export function isTransient(text: string | undefined, status?: number | null): boolean {
  const s = text ?? "";
  if (HARD.test(s)) return false;
  return status === 429 || status === 529 || status === 503 || RATE.test(s);
}

/**
 * Antigravity's own quota error, e.g. "RESOURCE_EXHAUSTED (code 429): Individual quota reached.
 * Please upgrade your subscription to increase your limits. Resets in 13h10m12s." (agy CLI log).
 */
export function agyQuota(text: string | undefined, now = Date.now()): Classified | undefined {
  const m = text?.match(/Individual quota reached\b[\s\S]*?\bResets in\s+((?:\d+(?:\.\d+)?\s*[dhms]\s*)+)/i);
  if (!m) return undefined;
  return { kind: "quota", definite: true, resetAt: parseReset(`in ${m[1]}`, now) };
}

/**
 * AWS Bedrock's own errors (Claude Code passes the message through, pi the SDK's exception): a
 * service quota or a per-day token/request limit is a quota (definite: there's no usage feed to
 * confirm it, and retrying won't help), ThrottlingException / "Too many requests|tokens, please
 * wait before trying again" is a rate limit (back off on the same model).
 */
export function bedrockFault(text: string | undefined, now = Date.now()): Classified | undefined {
  const s = text ?? "";
  if (/ServiceQuotaExceeded|service quota|quota (?:exceeded|limit)|too many (?:tokens|requests) per day/i.test(s)) {
    // A per-day quota resets at midnight UTC; others after the default cooldown, unless the text says.
    const midnight = /per day/i.test(s) ? new Date(now).setUTCHours(24, 0, 0, 0) : undefined;
    return { kind: "quota", definite: true, resetAt: parseReset(s, now) ?? midnight };
  }
  if (/ThrottlingException|too many (?:requests|tokens), please wait|ServiceUnavailableException|ModelNotReadyException|Rate exceeded/i.test(s)) return { kind: "rate_limit", resetAt: parseReset(s, now) };
  return undefined;
}

/** Whether an entry runs on Bedrock: a "#bedrock:" credential or pi's amazon-bedrock provider. */
export const onBedrock = (e: ChainEntry) => !!e.credential?.startsWith("bedrock:") || e.model.startsWith("amazon-bedrock/");

/** Best-effort reset time from messages like "try again in 2h 13m" or "retry after 30 seconds". */
export function parseReset(s: string, now = Date.now()): number | undefined {
  const m = s.match(/(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:d|days?|h|hours?|hrs?|m|mins?|minutes?|s|secs?|seconds?)\s*)+)/i);
  if (m) {
    let ms = 0;
    for (const [, n, u] of m[1]!.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
      const v = parseFloat(n!);
      const unit = u!.toLowerCase();
      ms += unit.startsWith("d") ? v * 864e5 : unit.startsWith("h") ? v * 36e5 : unit.startsWith("m") ? v * 6e4 : v * 1e3;
    }
    if (ms > 0) return now + ms;
  }
  const iso = s.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/);
  if (iso) {
    const t = Date.parse(iso[0]);
    if (t > now) return t;
  }
  return undefined;
}

/**
 * The unit a quota applies to. pi: the provider account ("openai-codex/gpt-6-luna" ->
 * "openai-codex"). Claude Code models have no provider prefix, and subscription limits can be
 * per model family, so each model is its own key ("claude-code:opus"). OpenAI-backed Codex
 * models share the ChatGPT account key; custom Codex routes get a route-specific key. On a
 * credential ("#azure:east") the key gets "#<credential>": account A at its limit leaves account B
 * usable.
 */
export function providerOf(model: string, harness: string, credential?: string): string {
  const cred = credential ? `#${credential}` : "";
  // On a Bedrock credential the quota is the model's on that account, whichever harness runs it:
  // Claude Code's "us.anthropic.…" and pi's "amazon-bedrock/us.anthropic.…" share one key.
  if (credential?.startsWith("bedrock:")) return `bedrock:${model.replace(/^amazon-bedrock\//, "")}${cred}`;
  if (harness === "codex") {
    const i = model.indexOf("/");
    const provider = i > 0 ? model.slice(0, i) : "openai";
    return (provider === "openai" ? "codex" : `codex:${provider}`) + cred;
  }
  const i = model.indexOf("/");
  return (i > 0 ? model.slice(0, i) : `${harness}:${model}`) + cred;
}

/** providerOf for a chain entry. */
export const quotaKey = (e: ChainEntry) => providerOf(e.model, e.harness, e.credential);

/** Same harness, model and credential. */
export const sameEntry = (a: ChainEntry, b: ChainEntry) => a.harness === b.harness && a.model === b.model && (a.credential ?? "") === (b.credential ?? "");

const DEFAULT_QUOTA_COOLDOWN = 60 * 60_000;

export function markExhausted(provider: string, resetAt?: number): number {
  const until = resetAt ?? Date.now() + DEFAULT_QUOTA_COOLDOWN;
  config().exhausted[provider] = until;
  saveConfig();
  return until;
}

export function exhaustedUntil(provider: string): number | undefined {
  const until = config().exhausted[provider];
  if (until && until > Date.now()) return until;
  if (until) {
    delete config().exhausted[provider];
    saveConfig();
  }
  return undefined;
}

/**
 * The account whose usage Tether can read for this entry: Claude Code runs on the Claude login,
 * Codex on the Codex CLI's ChatGPT login, pi's openai-codex provider on pi's ChatGPT login. pi on
 * Anthropic can't be tied to Claude Code's login, and other harnesses have no usage feed. A Codex
 * model routed to another provider ("openrouter/…") isn't on the ChatGPT login: none. An entry on
 * a credential isn't on those logins either: its plugin's usage, if any, is read instead (usageCheckable).
 */
export function accountOf(entry: ChainEntry): UsageAccount | undefined {
  if (entry.credential) return undefined;
  const p = usageProvider(entry.harness, entry.model);
  if (p === "claude") return entry.harness === "claude-code" ? "claude" : undefined;
  if (p === "codex") return entry.harness === "pi" ? "chatgpt:pi" : entry.harness === "codex" ? "chatgpt:codex" : undefined;
  return undefined;
}

/** Whether Tether can read this entry's usage: its login's (accountOf), or its credential plugin's. */
export const usageCheckable = (entry: ChainEntry) => (entry.credential ? canCheckUsage(entry.credential) : !!accountOf(entry));

/** Fresh usage for one account; tests and fault injection swap it (setUsageSource). */
let usageSource: (account: UsageAccount) => Promise<ProviderUsage | undefined> = accountUsage;
export function setUsageSource(fn?: (account: UsageAccount) => Promise<ProviderUsage | undefined>) {
  usageSource = fn ?? accountUsage;
}

/**
 * Whether the account's usage confirms the limit: a window at 100% (a model-scoped one only for
 * that model) or the provider's own limit_reached. The reset is the latest full window's.
 */
export function limitReached(u: ProviderUsage | undefined, model?: string): { resetAt?: number } | undefined {
  if (!u || u.error) return undefined;
  const m = (model ?? "").toLowerCase();
  const applies = (label: string) => {
    const scope = label.split("·")[1]?.trim().split(/\s+/)[0]?.toLowerCase();
    return !scope || m.includes(scope);
  };
  const full = u.windows.filter((w) => (w.percent ?? 0) >= 100 && applies(w.label));
  if (!full.length && !u.limited) return undefined;
  const resets = full.map((w) => w.resetsAt).filter((t): t is number => !!t && t > Date.now());
  return { resetAt: resets.length ? Math.max(...resets) : undefined };
}

/**
 * A usage check's outcome: `limit` when the account is at its limit; `unknown` when it couldn't be
 * checked (no account, no usage, the fetch failed or answered with an error).
 */
export type UsageCheck = { limit?: { resetAt?: number }; unknown?: boolean };

/** Fetches the entry's account usage now. */
export async function confirmLimit(entry: ChainEntry): Promise<UsageCheck> {
  const account = accountOf(entry);
  if (!usageCheckable(entry)) return { unknown: true };
  try {
    const u = entry.credential ? await credentialUsage(entry.credential) : await usageSource(account!);
    if (!u || u.error) return { unknown: true };
    return { limit: limitReached(u, entry.model) };
  } catch {
    return { unknown: true };
  }
}

/**
 * First chain entry whose quota is not exhausted, or the earliest reset time. `skip` adds a
 * caller's own "not before" times per quota key (a session's manual "Continue on …").
 */
export function pickEntry(chain: string[], harness: HarnessId, skip?: (provider: string) => number | undefined): { entry: ChainEntry } | { waitUntil: number } {
  let earliest = Infinity;
  for (const raw of chain) {
    const entry = parseEntry(raw, harness);
    // A harness that isn't installed (now) is passed over; the session's own one runs, so it is.
    if (entry.harness !== harness && !isInstalled(entry.harness)) continue;
    // So is one on a credential that is gone (its plugin or its record): like an uninstalled harness.
    if (!entryAvailable(entry)) continue;
    const key = quotaKey(entry);
    const until = exhaustedUntil(key) ?? skip?.(key);
    if (!until) return { entry };
    earliest = Math.min(earliest, until);
  }
  // Nothing usable and nothing that resets (only harnesses that aren't installed): look again later.
  return { waitUntil: Number.isFinite(earliest) ? earliest : Date.now() + DEFAULT_QUOTA_COOLDOWN };
}

/**
 * Whether a harness is installed on this runner, as index.ts last checked (kept fresh, so one
 * installed later becomes usable again). Everything counts as installed until it has checked.
 */
let installedCheck: (h: HarnessId) => boolean = () => true;
export function setInstalledCheck(fn?: (h: HarnessId) => boolean) {
  installedCheck = fn ?? (() => true);
}
export const isInstalled = (h: HarnessId) => installedCheck(h);

export function backoffMs(attempt: number): number {
  return Math.min(5 * 60_000, 15_000 * 2 ** Math.min(attempt, 5));
}

/**
 * Where "Continue on …" goes: the first entry after `current` in the chain whose quota isn't known
 * to be exhausted (from the top when the session runs on something outside the chain).
 */
export function nextEntry(chain: string[], current: ChainEntry, harness: HarnessId): ChainEntry | undefined {
  const entries = chain.map((raw) => parseEntry(raw, harness));
  const same = (e: ChainEntry) => sameEntry(e, current);
  const at = entries.findIndex(same);
  return entries.slice(at + 1).find((e) => !same(e) && (e.harness === harness || isInstalled(e.harness)) && entryAvailable(e) && !exhaustedUntil(quotaKey(e)));
}
