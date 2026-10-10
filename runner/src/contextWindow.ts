// How full each harness's context window is. Every adapter turns what its harness reports into
// one ContextUsage: the tokens the model saw on its last request (not session totals) and the
// model's window. When a harness doesn't report the window, knownWindow() guesses from the name.

import type { ContextUsage } from "../../web/src/shared/protocol";

const num = (n: unknown): number | undefined => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined);
const sum = (...ns: (number | undefined)[]) => ns.reduce<number>((a, n) => a + (n ?? 0), 0);

/** Context windows of models whose harness may not report one. Model ids may carry a "provider/" prefix. */
export function knownWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (m.includes("[1m]")) return 1_000_000;
  const id = m.slice(m.lastIndexOf("/") + 1);
  // Claude: 1M from the 5 family on, 200k before. Bare aliases ("opus") are left to the harness.
  const claude = id.match(/^claude-(\d+)-/) ?? id.match(/(?:opus|sonnet|haiku)-(\d+)/);
  if (claude) return Number(claude[1]) >= 5 ? 1_000_000 : 200_000;
  if (id.startsWith("gemini")) return 1_048_576;
  if (id.startsWith("gpt-oss")) return 131_072;
  if (/^gpt-4\.1/.test(id)) return 1_047_576;
  if (/^gpt-4o/.test(id)) return 128_000;
  if (/^o[34]\b/.test(id)) return 200_000;
  if (/^gpt-5/.test(id)) return 272_000;
  return undefined;
}

/** Fills `max` from the model name when the harness gave none. */
export function withKnownMax(c: ContextUsage): ContextUsage {
  if (c.max !== undefined) return c;
  const max = knownWindow(c.model);
  return max ? { ...c, max, maxEstimated: true } : c;
}

/**
 * A new report on top of the last one. Fields it leaves out keep their value (a request's usage
 * doesn't repeat the window), unless it is for another model, whose window differs.
 */
export function mergeContext(prev: ContextUsage | undefined, c: ContextUsage): ContextUsage {
  const next: ContextUsage = prev && (!c.model || !prev.model || c.model === prev.model) ? { ...prev } : { model: prev?.model };
  for (const [k, v] of Object.entries(c)) if (v !== undefined) (next as any)[k] = v;
  if (c.max !== undefined) next.maxEstimated = c.maxEstimated;
  return withKnownMax(next);
}

/**
 * After a model switch: the conversation is the same size, but the window is the new model's.
 * Keeps the old window when the new one is unknown (it is corrected by the next report).
 */
export function switchModel(c: ContextUsage | undefined, model: string): ContextUsage | undefined {
  if (!c || c.model === model) return c;
  const max = knownWindow(model);
  return { ...c, model, max: max ?? c.max, maxEstimated: true };
}

// ---------- Claude Code ----------

/** An Anthropic API `usage` block (message_start, assistant messages): what this request read. */
export function anthropicUsage(u: any, model?: string): ContextUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const input = num(u.input_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens);
  if (input === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined;
  return { used: sum(input, cacheRead, cacheWrite), input, cacheRead, cacheWrite, ...(model ? { model } : {}) };
}

const baseModel = (m: string) => m.toLowerCase().replace(/\[[^\]]*\]$/, "");

/** The main model's window from a result's `modelUsage` (it also lists helper models like Haiku). */
export function claudeWindow(modelUsage: any, model: string | undefined): number | undefined {
  if (!modelUsage || typeof modelUsage !== "object" || !model) return undefined;
  const want = baseModel(model);
  let best: number | undefined;
  for (const [k, v] of Object.entries<any>(modelUsage)) {
    const key = baseModel(k);
    const canon = v?.canonicalModel ? baseModel(v.canonicalModel) : undefined;
    if (key !== want && canon !== want && !key.startsWith(want) && !want.startsWith(key)) continue;
    const w = num(v?.contextWindow);
    if (w && (!best || w > best)) best = w;
  }
  return best;
}

/** A stored session (getSessionMessages): the last main-thread reply's usage. */
export function claudeHistoryContext(list: any[]): ContextUsage | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m?.type !== "assistant" || m.parent_tool_use_id || !m.message?.usage) continue;
    const c = anthropicUsage(m.message.usage, m.message.model);
    if (c) return c;
  }
  return undefined;
}

/** The SDK's getContextUsage() answer: the estimate Claude Code's own /context shows. */
export function claudeContextUsage(r: any): ContextUsage | undefined {
  if (!r || typeof r !== "object") return undefined;
  const max = num(r.rawMaxTokens) || num(r.maxTokens) || undefined;
  const api = anthropicUsage(r.apiUsage);
  const used = api?.used ?? num(r.totalTokens);
  if (used === undefined && max === undefined) return undefined;
  return { ...api, used, max, ...(r.model ? { model: r.model } : {}) };
}

// ---------- Codex ----------

/** app-server `thread/tokenUsage/updated` (ThreadTokenUsage). `last` is the latest request; input includes cached. */
export function codexTokenUsage(u: any, model?: string): ContextUsage | undefined {
  const last = u?.last;
  if (!last) return undefined;
  const input = num(last.inputTokens);
  if (input === undefined) return undefined;
  const cacheRead = num(last.cachedInputTokens);
  const cacheWrite = num(last.cacheWriteInputTokens) || undefined;
  const max = num(u.modelContextWindow) || undefined;
  return { used: input, input: input - (cacheRead ?? 0) - (cacheWrite ?? 0), cacheRead, cacheWrite, max, ...(model ? { model } : {}) };
}

/** The last token count in a Codex rollout file (JSONL); unknown when the thread compacted after it. */
export function codexRollout(text: string, model?: string): ContextUsage | undefined {
  let found: ContextUsage | undefined;
  for (const line of text.split("\n")) {
    if (line.includes('"token_count"')) {
      try {
        const info = JSON.parse(line).payload?.info;
        const l = info?.last_token_usage;
        if (!l) continue;
        found = codexTokenUsage(
          {
            last: { inputTokens: l.input_tokens, cachedInputTokens: l.cached_input_tokens, cacheWriteInputTokens: l.cache_write_input_tokens },
            modelContextWindow: info.model_context_window,
          },
          model,
        );
      } catch {}
    } else if (found && (line.includes('"type":"compacted"') || line.includes('"context_compacted"'))) {
      found = { ...found, used: undefined, input: undefined, cacheRead: undefined, cacheWrite: undefined };
    }
  }
  return found;
}

// ---------- pi ----------

/** `get_session_stats`: contextUsage.tokens is null right after compaction. */
export function piStats(stats: any, model?: string): ContextUsage | undefined {
  const c = stats?.contextUsage;
  if (!c) return undefined;
  const max = num(c.contextWindow) || undefined;
  const used = num(c.tokens);
  if (used === undefined && max === undefined) return undefined;
  return { used, max, ...(model ? { model } : {}) };
}

// ---------- ACP (opencode, Kiro) ----------

/** ACP `usage_update`: used / size of the context window. */
export function acpUsage(u: any, model?: string): ContextUsage | undefined {
  const used = num(u?.used);
  const max = num(u?.size) || undefined;
  if (used === undefined && max === undefined) return undefined;
  return { used, max, ...(model ? { model } : {}) };
}

// ---------- Antigravity ----------

/**
 * A step's `usage` ({input_tokens, cache_read_tokens, …}): what that model request read. agy's
 * input_tokens leaves out cache reads (measured on 1.3.3: a 57.5k-token request was followed by
 * input 2,580 + cache_read 55,459), so the two add up. A `result` event's usage is the running
 * total of the whole process, not the context, so it isn't used here.
 */
export function agyUsage(u: any, model?: string): ContextUsage | undefined {
  const input = num(u?.input_tokens);
  if (input === undefined) return undefined;
  // 0 is kept: a report leaves out what it doesn't set (mergeContext), so an earlier cache read would linger.
  const cacheRead = num(u.cache_read_tokens);
  return { used: sum(input, cacheRead), input, cacheRead, ...(model ? { model } : {}) };
}
