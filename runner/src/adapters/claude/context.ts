// How full a Claude session's context is (SPEC §5). The tokens come from the last main-thread
// message: what it was sent with is the context, compaction and all. The window is what Claude Code
// reports in a result: stored sessions have none, so Tether keeps the last reported ones in a small
// JSON file in the runner's config dir (mode 600; in memory under `bun test`), and falls back on
// Claude Code's own model catalog. No table of Tether's: windows change with models and accounts.

import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BillingSource } from "../../../../shared/credentials";
import { mergePlan, reportedAt } from "../../../../shared/labels";
import { UNKNOWN_BILLING, type Billing, type ContextUse, type PlanUsage, type PlanWindow } from "../../../../shared/transcript";
import { CONFIG_DIR } from "../../config";
import type { PlanIdentity } from "../../core/adapter";
import type { Entry } from "./jsonl";

export interface IdentityTaggedPlan {
  identity: PlanIdentity;
  plan: PlanUsage;
}

/** Normalized org comparison (matches claude/credentials.ts). */
function normOrg(name: string, email?: string) {
  const normalized = name.replace(/[‘’]/g, "'").replace(/\s+/g, "");
  return email && normalized.toLowerCase() === `${email.toLowerCase()}'sorganization` ? normalized.toLowerCase() : normalized;
}

export function samePlanIdentity(a: PlanIdentity | undefined, b: PlanIdentity | undefined): boolean {
  if (!a || !b) return false;
  return a.accountId === b.accountId &&
    a.email.toLowerCase() === b.email.toLowerCase() &&
    normOrg(a.organization, a.email) === normOrg(b.organization, b.email);
}

interface Windows {
  /** the last reported window of a model */
  models: Record<string, number>;
  /** the window a session last reported, for its model: a [1m] variant shares the model's id */
  sessions: Record<string, { model: string; window: number; at: number }>;
  /** what each session drew from on its latest start; only the start says */
  billing?: Record<string, Billing & { at: number }>;
  /** legacy untagged plan (ignored for fallback skip decisions) */
  plan?: PlanUsage;
  /** per-source identity-tagged plan windows (main login and extra accounts, G4) */
  plans?: Record<string, IdentityTaggedPlan>;
}

const MAX_SESSIONS = 2000;

let file: string | undefined = process.env.NODE_ENV === "test" ? undefined : join(CONFIG_DIR, "claude-windows.json");
let kept: Windows | undefined;

/** Tests: where it's kept (undefined: memory only), starting empty. */
export function windowsIn(path: string | undefined) {
  file = path;
  kept = undefined;
  catalog = undefined;
}

function load(): Windows {
  if (kept) return kept;
  kept = { models: {}, sessions: {} };
  if (file)
    try {
      kept = { ...kept, ...JSON.parse(readFileSync(file, "utf8")) };
    } catch {}
  return kept!;
}

function save() {
  if (!file || !kept) return;
  const newest = Object.entries(kept.sessions).sort((a, b) => b[1].at - a[1].at);
  kept.sessions = Object.fromEntries(newest.slice(0, MAX_SESSIONS));
  kept.billing = Object.fromEntries(Object.entries(kept.billing ?? {}).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_SESSIONS));
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(kept), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch {}
}

/** A result's modelUsage: the windows Claude Code reports, by model (cumulative, background models too). */
export function noteWindows(modelUsage: unknown, sessionId: string, model: string | undefined) {
  if (!modelUsage || typeof modelUsage !== "object") return;
  const w = load();
  let changed = false;
  for (const [id, u] of Object.entries(modelUsage as Record<string, any>)) {
    const window = u?.contextWindow;
    if (typeof window !== "number" || window <= 0) continue;
    if (w.models[id] !== window) (w.models[id] = window), (changed = true);
    const had = w.sessions[sessionId];
    if (id === model && (had?.model !== id || had.window !== window)) {
      w.sessions[sessionId] = { model: id, window, at: Date.now() };
      changed = true;
    }
  }
  if (changed) save();
}

/**
 * A rate_limit_event's plan limits. Each may name one window (rateLimitType) and, on newer CLIs, all
 * it knows (unifiedWindows): utilization 0 to 1, resets in seconds. With unifiedWindows the report
 * is complete: a window it doesn't list, the plan no longer has (some plans have only the week).
 * Without, windows it doesn't name are left as they were. A rejected one marks its window
 * exhausted. Undefined: no number in it.
 */
export function planOf(info: any): PlanUsage | undefined {
  const window = (w: any): PlanWindow | undefined =>
    typeof w?.utilization === "number" ? { percent: Math.round(w.utilization * 100), ...(typeof w.resetsAt === "number" ? { resetsAt: w.resetsAt * 1000 } : {}) } : undefined;
  // A rejection names the window that's out: exhausted, at 100% if it gave no figure.
  const out = (type: string, w: PlanWindow | undefined): PlanWindow | undefined =>
    info?.status !== "rejected" || info?.rateLimitType !== type ? w : { percent: 100, ...(typeof info.resetsAt === "number" ? { resetsAt: info.resetsAt * 1000 } : {}), ...w, exhausted: true };
  const pick = (type: string) => out(type, window(info?.unifiedWindows?.[type]) ?? (info?.rateLimitType === type ? window(info) : undefined));
  const [fiveHour, week] = [pick("five_hour"), pick("seven_day")];
  const complete = typeof info?.unifiedWindows === "object" && info.unifiedWindows !== null;
  return fiveHour || week ? { ...(fiveHour ? { fiveHour } : {}), ...(week ? { week } : {}), ...(complete ? { complete } : {}) } : undefined;
}

const PROVIDERS: Record<string, string> = {
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex",
  foundry: "Microsoft Foundry",
  anthropicAws: "Anthropic on AWS",
  anthropicGoogleCloud: "Anthropic on Google Cloud",
  mantle: "Amazon Bedrock",
  gateway: "Gateway",
};

/**
 * What Claude Code's accountInfo says the session draws from. A key wins over a login: with
 * ANTHROPIC_API_KEY set it still reports tokenSource "claude.ai", and the key is what's used.
 */
export function claudeBilling(a: any): Billing {
  if (a?.apiProvider && a.apiProvider !== "firstParty") return PROVIDERS[a.apiProvider] ? { kind: "provider", label: PROVIDERS[a.apiProvider] } : UNKNOWN_BILLING;
  if (a?.apiKeySource && a.apiKeySource !== "none" && a.apiKeySource !== "oauth") return { kind: "apiKey", label: "Anthropic API key" };
  if (a?.subscriptionType) return { kind: "plan", label: "Claude plan" };
  if (a?.tokenSource && a.tokenSource !== "claude.ai") return { kind: "apiKey", label: "Anthropic auth token" };
  return UNKNOWN_BILLING;
}

export function keepBilling(sessionId: string, billing: Billing) {
  const w = load();
  (w.billing ??= {})[sessionId] = { ...billing, at: Date.now() };
  save();
}
/** Claude's TUI says nothing of what it runs on: a start there leaves this unknown. */
export function forgetBilling(sessionId: string) {
  const w = load();
  if (w.billing?.[sessionId]) {
    delete w.billing[sessionId];
    save();
  }
}
export function keptBilling(sessionId: string): Billing {
  const b = load().billing?.[sessionId];
  return b ? { kind: b.kind, label: b.label, ...(b.source ? { source: b.source } : {}) } : UNKNOWN_BILLING;
}
/** The same, with when that start was (ms); undefined when none is kept. */
export function keptStart(sessionId: string): (Billing & { at: number }) | undefined {
  const b = load().billing?.[sessionId];
  return b && typeof b.at === "number" ? { kind: b.kind, label: b.label, at: b.at } : undefined;
}

/** The latest report, kept for stored sessions and fallback usage checks after a restart (G4). */
export function keepPlan(report: PlanUsage, source: BillingSource = "subscription", identity?: PlanIdentity) {
  const w = load();
  const stamped = reportedAt(report);
  if (identity) {
    w.plans ??= {};
    const existing = w.plans[source];
    w.plans[source] = existing && samePlanIdentity(existing.identity, identity)
      ? { identity, plan: mergePlan(existing.plan, stamped) }
      : { identity, plan: stamped };
    if (source === "subscription") delete w.plan;
  } else {
    w.plan = mergePlan(w.plan, stamped);
  }
  save();
}

export function keptPlan(source: BillingSource = "subscription", expectedIdentity?: PlanIdentity): PlanUsage | undefined {
  const w = load();
  if (expectedIdentity) {
    const entry = w.plans?.[source];
    return entry && samePlanIdentity(entry.identity, expectedIdentity) ? entry.plan : undefined;
  }
  return w.plans?.[source]?.plan ?? (source === "subscription" ? w.plan : undefined);
}

/** All identity-tagged plan entries persisted on disk, for startup loading into SessionCore (G4). */
export function keptPlanEntries(): Record<string, IdentityTaggedPlan> {
  return { ...(load().plans ?? {}) };
}

const CATALOG_MS = 10 * 60_000;
let catalog: { at: number; models: Record<string, number> } | undefined;

/** Claude Code's cache of its model catalog: each model's input limit, for this account. */
function catalogWindows(): Record<string, number> {
  if (catalog && Date.now() - catalog.at < CATALOG_MS) return catalog.models;
  const models: Record<string, number> = {};
  try {
    const dir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "cache", "model-catalog");
    const newest = readdirSync(dir)
      .filter((f) => f.endsWith("-cc.json"))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    const list = newest ? JSON.parse(readFileSync(join(dir, newest.f), "utf8"))?.catalog?.config?.models : undefined;
    for (const m of Array.isArray(list) ? list : []) if (typeof m?.id === "string" && m.runtime?.max_input_tokens > 0) models[m.id] = m.runtime.max_input_tokens;
  } catch {}
  catalog = { at: Date.now(), models };
  return models;
}

/** A model's window: as this session reported it, as the model last reported it, else the catalog's. */
export function windowOf(model: string, sessionId: string): number | undefined {
  const w = load();
  const own = w.sessions[sessionId];
  if (own?.model === model) return own.window;
  if (w.models[model]) return w.models[model];
  // Turned off by this switch, Claude Code runs a smaller window than the catalog's.
  return process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT ? undefined : catalogWindows()[model];
}

/** The tokens a message was sent with. */
export function contextUsed(usage: any): number {
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  return n(usage?.input_tokens) + n(usage?.cache_read_input_tokens) + n(usage?.cache_creation_input_tokens);
}

/** The context, when the window is known and the count fits it. */
export function contextOf(used: number, model: string, sessionId: string): ContextUse | undefined {
  const total = windowOf(model, sessionId);
  return used > 0 && total && total >= used ? { used, total } : undefined;
}

/**
 * A stored conversation's context: its last real main-thread message's. After a compaction with no
 * message since it's not known: the store has only the compaction's own count, which leaves out the
 * system prompt and tools (real run: 10.5k said, 33k on the next message).
 */
export function chainContext(chain: Entry[], sessionId: string): ContextUse | undefined {
  for (let i = chain.length - 1; i >= 0; i--) {
    const e = chain[i]!;
    if (e.type === "system" && e.subtype === "compact_boundary") return undefined;
    if (e.type !== "assistant" || e.isSidechain) continue;
    const model = e.message?.model;
    const used = contextUsed(e.message?.usage);
    if (typeof model === "string" && !model.startsWith("<") && used) return contextOf(used, model, sessionId);
  }
  return undefined;
}
