// Dev-only fault injection (TETHER_DEV=1), for exercising fallback against real harnesses
// (docs/fallback-testing.md). Typed into a session, handled by the runner before the harness sees
// anything:
//
//   /tether simulate-limit <quota|rate|other> [after <n> tools] [reset <dur>] [now]
//   /tether simulate-limit off
//   /tether simulate-usage <claude|codex|kiro> <pct> [reset <dur>]
//   /tether simulate-usage clear
//   /tether exhausted <chain entry> <dur>
//   /tether exhausted clear
//
// simulate-limit makes that session's adapter end its next turn (or the running one, with `now`;
// or that turn once n tool calls have finished) with its harness's own error, built here in the
// harness's real wire shape and fed to the adapter's own parser, so the real classification and
// fallback path runs (session.ts handleTurnError). simulate-usage stands in for an account's usage
// (usage.ts), in the usage bar and in fallback's verification fetch, until cleared. exhausted
// sets or clears the runner's own record of limits (runner.json `exhausted`, which the running
// runner keeps in memory and writes back, so editing the file under it doesn't stick).

import type { ProviderUsage } from "../../web/src/shared/protocol";

export type FaultKind = "quota" | "rate" | "other";

export interface Fault {
  kind: FaultKind;
  /** fire once this many tool calls of the turn have finished (0: as the turn starts) */
  afterTools: number;
  /** when the simulated limit resets, from when it fires */
  resetMs?: number;
  /** fire in the turn that is running now rather than the next one */
  now?: boolean;
}

export type DevCommand =
  | { cmd: "limit"; fault: Fault }
  | { cmd: "limit-off" }
  | { cmd: "usage"; provider: ProviderUsage["provider"]; percent: number; resetMs?: number }
  | { cmd: "usage-clear" }
  | { cmd: "exhausted"; entry: string; ms: number }
  | { cmd: "exhausted-clear" }
  | { cmd: "error"; text: string };

export const devMode = () => process.env.TETHER_DEV === "1";

const USAGE = "Usage: /tether simulate-limit <quota|rate|other> [after <n> tools] [reset <dur>] [now], /tether simulate-limit off, /tether simulate-usage <claude|codex|kiro> <pct> [reset <dur>], /tether simulate-usage clear, /tether exhausted <chain entry> <dur>, /tether exhausted clear";

/** "2h", "90m", "1h30m", "45s", "1d" → ms; undefined when it isn't a duration. */
export function parseDuration(s: string): number | undefined {
  if (!/^(\d+(\.\d+)?[dhms])+$/i.test(s)) return undefined;
  let ms = 0;
  for (const [, n, u] of s.matchAll(/(\d+(?:\.\d+)?)([dhms])/gi)) ms += parseFloat(n!) * { d: 864e5, h: 36e5, m: 6e4, s: 1e3 }[u!.toLowerCase() as "d"]!;
  return ms > 0 ? ms : undefined;
}

/** A `/tether …` dev command; undefined for anything else (and always outside TETHER_DEV=1). */
export function parseDevCommand(text: string, dev = devMode()): DevCommand | undefined {
  if (!dev) return undefined;
  const words = text.trim().split(/\s+/);
  if (words[0] !== "/tether") return undefined;
  const [verb, ...rest] = words.slice(1);
  const bad = (why: string): DevCommand => ({ cmd: "error", text: `${why} ${USAGE}` });
  if (verb === "simulate-limit") {
    if (rest[0] === "off") return { cmd: "limit-off" };
    const kind = rest.shift();
    if (kind !== "quota" && kind !== "rate" && kind !== "other") return bad(`Unknown limit kind "${kind ?? ""}".`);
    const fault: Fault = { kind, afterTools: 0 };
    while (rest.length) {
      const w = rest.shift()!;
      if (w === "now") fault.now = true;
      else if (w === "after") {
        const n = Number(rest.shift());
        if (!Number.isInteger(n) || n < 0) return bad("`after` takes a number of tool calls.");
        if (/^tools?$/.test(rest[0] ?? "")) rest.shift();
        fault.afterTools = n;
      } else if (w === "reset") {
        const ms = parseDuration(rest.shift() ?? "");
        if (!ms) return bad("`reset` takes a duration like 90m or 2h.");
        fault.resetMs = ms;
      } else return bad(`Unexpected "${w}".`);
    }
    return { cmd: "limit", fault };
  }
  if (verb === "simulate-usage") {
    if (rest[0] === "clear" || rest[0] === "off") return { cmd: "usage-clear" };
    const provider = rest[0];
    if (provider !== "claude" && provider !== "codex" && provider !== "kiro") return bad(`Unknown usage source "${provider ?? ""}".`);
    const percent = Number(rest[1]?.replace(/%$/, ""));
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return bad("The percentage must be 0 to 100.");
    let resetMs: number | undefined;
    if (rest[2] === "reset") {
      resetMs = parseDuration(rest[3] ?? "");
      if (!resetMs) return bad("`reset` takes a duration like 90m or 2h.");
    } else if (rest[2]) return bad(`Unexpected "${rest[2]}".`);
    return { cmd: "usage", provider, percent, resetMs };
  }
  if (verb === "exhausted") {
    if (rest[0] === "clear" && rest.length === 1) return { cmd: "exhausted-clear" };
    const ms = parseDuration(rest[1] ?? "");
    if (!rest[0] || !ms || rest.length > 2) return bad("`exhausted` takes a chain entry and a duration, like `claude-code:sonnet 3m`, or `clear`.");
    return { cmd: "exhausted", entry: rest[0], ms };
  }
  return bad(`Unknown command "${verb ?? ""}".`);
}

/** Default time to the simulated reset. */
const RESET_MS: Record<FaultKind, number> = { quota: 60 * 60_000, rate: 20_000, other: 0 };
export const resetOf = (f: Fault, now = Date.now()) => now + (f.resetMs ?? RESET_MS[f.kind]);

/** A stand-in usage report: one window at `percent` (Kiro's a credit pool, the others a 5-hour window). */
export function simulatedUsage(provider: ProviderUsage["provider"], percent: number, resetMs = 60 * 60_000, now = Date.now()): ProviderUsage {
  const p = Math.round(percent);
  const label = provider === "claude" ? "Claude" : provider === "kiro" ? "Kiro" : "Codex";
  return {
    provider,
    label: `${label} (simulated)`,
    windows: [{ label: provider === "kiro" ? "Credits" : "5h", percent: p, resetsAt: now + resetMs, ...(provider === "kiro" ? { used: p * 10, limit: 1000 } : {}) }],
    ...((provider === "codex" || provider === "kiro") && p >= 100 ? { limited: true } : {}),
  };
}

/** "5pm", "5:30pm": how Claude Code names a reset time. */
function clock(ms: number) {
  const d = new Date(ms);
  const h = d.getHours() % 12 || 12;
  const m = d.getMinutes();
  return `${h}${m ? `:${String(m).padStart(2, "0")}` : ""}${d.getHours() < 12 ? "am" : "pm"}`;
}

// ---- each harness's own error, in its wire shape ----

/**
 * Claude Code (Agent SDK messages): a usage limit is a `rate_limit_event` with status "rejected"
 * (overage not available), then the synthetic assistant message with `error: "rate_limit"` and the
 * "You've hit your limit · resets 5pm" text, then an error result. A 429 is the same assistant
 * error without the rejected event; anything else an API error.
 */
export function claudeFault(f: Fault, sessionId: string, now = Date.now(), bedrock = false): any[] {
  const base = { uuid: crypto.randomUUID(), session_id: sessionId };
  const reset = resetOf(f, now);
  // On Bedrock (CLAUDE_CODE_USE_BEDROCK) there's no rate_limit_event: AWS's own messages come through.
  const bk = bedrock && f.kind !== "other" ? f.kind : undefined;
  const [error, status, text] = bk
    ? ["rate_limit", bk === "quota" ? 400 : 429, `API Error: ${bedrockFaultText(bk)}`]
    : f.kind === "quota"
      ? ["rate_limit", 429, `You've hit your limit · resets ${clock(reset)}`]
      : f.kind === "rate"
        ? ["rate_limit", 429, "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later."]
        : ["server_error", 500, 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}'];
  const out: any[] = [];
  if (f.kind === "quota" && !bk)
    out.push({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: Math.floor(reset / 1000), rateLimitType: "five_hour", overageStatus: "rejected", overageDisabledReason: "org_level_disabled", isUsingOverage: false },
      ...base,
    });
  out.push({
    type: "assistant",
    message: { id: `msg_sim_${now.toString(36)}`, type: "message", role: "assistant", model: "<synthetic>", content: [{ type: "text", text }], stop_reason: "stop_sequence", stop_sequence: "", usage: { input_tokens: 0, output_tokens: 0 } },
    parent_tool_use_id: null,
    error,
    ...base,
    uuid: crypto.randomUUID(),
  });
  out.push({ type: "result", subtype: "success", is_error: true, result: text, api_error_status: status, duration_ms: 0, duration_api_ms: 0, num_turns: 1, stop_reason: "stop_sequence", total_cost_usd: 0, ...base, uuid: crypto.randomUUID() });
  return out;
}

/**
 * Codex app-server notifications: a usage limit updates the account's rate limits (the 5-hour
 * window at 100%) and fails the turn with `codexErrorInfo: "usageLimitExceeded"`. A 429 fails it
 * after Codex's own retries (`responseTooManyFailedAttempts` with the status); anything else is an
 * internal server error. `turn` is the turn as Codex reported its end.
 */
export function codexFault(f: Fault, threadId: string, turn: any, now = Date.now()): [string, any][] {
  const reset = resetOf(f, now);
  const error =
    f.kind === "quota"
      ? {
          message: `You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at ${new Date(reset).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.`,
          codexErrorInfo: "usageLimitExceeded",
        }
      : f.kind === "rate"
        ? { message: "exceeded retry limit, last status: 429 Too Many Requests", codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } }
        : { message: "Internal server error", codexErrorInfo: "internalServerError" };
  const turnError = { ...error, additionalDetails: null, misalignment: null };
  const out: [string, any][] = [];
  if (f.kind === "quota")
    out.push([
      "account/rateLimits/updated",
      {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          normalModelSlug: null,
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.floor(reset / 1000) },
          secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: Math.floor((now + 4 * 864e5) / 1000) },
          credits: null,
          individualLimit: null,
          spendControlReached: null,
          planType: null,
          rateLimitReachedType: "rate_limit_reached",
        },
      },
    ]);
  out.push(["error", { error: turnError, willRetry: false, threadId, turnId: turn?.id ?? "" }]);
  out.push(["turn/completed", { threadId, turn: { ...turn, status: "failed", error: turnError } }]);
  return out;
}

/**
 * pi: the turn's last assistant message ends with `stopReason: "error"` and the provider's text.
 * On the ChatGPT login (openai-codex) a usage limit reads "You have hit your ChatGPT usage limit
 * (plus plan). Try again in ~N min." (pi-ai openai-codex-responses.js); other providers pass the
 * API's error message through.
 */
export function piFault(f: Fault, model: string | undefined, now = Date.now()): any {
  const [provider, ...rest] = (model ?? "").split("/");
  const mins = Math.max(0, Math.round((resetOf(f, now) - now) / 60_000));
  const errorMessage =
    provider === "amazon-bedrock" && f.kind !== "other"
      ? bedrockFaultText(f.kind)
      : f.kind === "quota"
      ? provider === "openai-codex"
        ? `You have hit your ChatGPT usage limit (plus plan). Try again in ~${mins} min.`
        : `429 {"type":"error","error":{"type":"rate_limit_error","message":"You have reached your usage limit. Your limit resets in ${mins} minutes."}}`
      : f.kind === "rate"
        ? `429 Rate limit reached for ${rest.join("/") || "this model"} on tokens per min (TPM). Please try again in ${Math.max(1, Math.round((resetOf(f, now) - now) / 1000))}s.`
        : "500 Internal server error";
  return {
    type: "message_end",
    message: { role: "assistant", content: [], api: "", provider, model: rest.join("/"), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: "error", errorMessage, timestamp: now },
  };
}

/** AWS Bedrock's own wording: a service quota, or ThrottlingException (pi shows the SDK exception's name). */
export function bedrockFaultText(kind: "quota" | "rate"): string {
  return kind === "quota"
    ? "ServiceQuotaExceededException: Your request exceeds the service quota for your account. You can view your quotas at https://console.aws.amazon.com/servicequotas/."
    : "ThrottlingException: Too many requests, please wait before trying again.";
}

/**
 * ACP (opencode, Kiro): no structured limit signal exists; the prompt request fails with a
 * JSON-RPC internal error carrying the provider's message (RequestError.internalError(data)).
 */
export function acpFault(f: Fault, now = Date.now()): { code: number; message: string; data: { message: string } } {
  const secs = Math.max(1, Math.round((resetOf(f, now) - now) / 1000));
  const message =
    f.kind === "quota"
      ? `You have reached your usage limit. Your limit resets in ${Math.round(secs / 60)} minutes.`
      : f.kind === "rate"
        ? `Rate limit exceeded (429 Too Many Requests). Please try again in ${secs}s.`
        : "Internal server error";
  return { code: -32603, message: "Internal error", data: { message } };
}

/**
 * Antigravity (agy stream-json): an error step, then a result with status ERROR. A usage limit is
 * "RESOURCE_EXHAUSTED (code 429): Individual quota reached. … Resets in 13h10m12s." (agy CLI log).
 */
export function agyFault(f: Fault, now = Date.now()): any[] {
  const left = Math.max(1, Math.round((resetOf(f, now) - now) / 1000));
  const span = `${Math.floor(left / 3600)}h${Math.floor((left % 3600) / 60)}m${left % 60}s`;
  const error =
    f.kind === "quota"
      ? `RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in ${span}.`
      : f.kind === "rate"
        ? "RESOURCE_EXHAUSTED (code 429): Too many requests. Please try again later."
        : "INTERNAL (code 500): Internal error encountered.";
  return [
    { event: "step_update", step_update: { step_index: 9999, step_type: "error_message", state: "DONE" } },
    { event: "result", result: { status: "ERROR", error } },
  ];
}

/** How the fault will show, for the confirmation notice (`now` while nothing runs: the next turn). */
export function describeFault(f: Fault, running = true): string {
  const what = f.kind === "quota" ? "a usage limit" : f.kind === "rate" ? "a rate limit (429)" : "a server error";
  const when = f.now && running ? "this turn" : "the next turn";
  const after = f.afterTools ? ` after ${f.afterTools} tool ${f.afterTools === 1 ? "call" : "calls"}` : "";
  const reset = f.kind !== "other" ? ` It resets ${fmtSpan(f.resetMs ?? RESET_MS[f.kind])} after it hits.` : "";
  return `Simulating ${what}: ${when} ends with this harness's own error${after}.${reset}`;
}

export function fmtSpan(ms: number) {
  const m = Math.round(ms / 60_000);
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
