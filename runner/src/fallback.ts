// Model profiles and quota-aware fallback, shared by every harness.
//
// Policy (agreed with the user):
//  - quota exhausted (hard limit, resets later): mark the provider exhausted until its reset
//    time and move down the chain;
//  - rate limited (transient): stay on the model and retry with backoff, forever;
//  - before every retry and every new turn, go back to the earliest model in the chain whose
//    provider has reset;
//  - everything exhausted: wait for the earliest reset, then continue.

import { parseEntry, type ChainEntry, type HarnessId } from "../../web/src/shared/protocol";
import { availableProfiles, config, saveConfig } from "./config";

export type ErrorKind = "quota" | "rate_limit" | "other";

export interface Classified {
  kind: ErrorKind;
  resetAt?: number;
}

const QUOTA = /quota|usage limit|insufficient_quota|exceeded your current|limit (has been )?reached|out of credits|billing|credit balance|plan limit|weekly limit|5-hour limit|resets? (at|in)/i;
const RATE = /\b429\b|rate.?limit|too many requests|overloaded|\b529\b|\b503\b|try again (later|in)|capacity/i;

export function classify(text: string | undefined, status?: number | null): Classified {
  const s = text ?? "";
  if (QUOTA.test(s)) return { kind: "quota", resetAt: parseReset(s) };
  if (status === 429 || status === 529 || RATE.test(s)) return { kind: "rate_limit", resetAt: parseReset(s) };
  return { kind: "other" };
}

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
 * per model family, so each model is its own key ("claude-code:opus"). Codex limits are per
 * ChatGPT account, so all its models share one key.
 */
export function providerOf(model: string, harness: string): string {
  if (harness === "codex") return "codex";
  const i = model.indexOf("/");
  return i > 0 ? model.slice(0, i) : `${harness}:${model}`;
}

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

/** First chain entry whose quota is not exhausted, or the earliest reset time. */
export function pickEntry(chain: string[], harness: HarnessId): { entry: ChainEntry } | { waitUntil: number } {
  let earliest = Infinity;
  for (const raw of chain) {
    const entry = parseEntry(raw, harness);
    const until = exhaustedUntil(providerOf(entry.model, entry.harness));
    if (!until) return { entry };
    earliest = Math.min(earliest, until);
  }
  return { waitUntil: earliest };
}

export function profile(name: string | undefined) {
  return name ? availableProfiles().find((p) => p.name === name) : undefined;
}

export function backoffMs(attempt: number): number {
  return Math.min(5 * 60_000, 15_000 * 2 ** Math.min(attempt, 5));
}
