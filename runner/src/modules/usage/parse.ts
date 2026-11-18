// Reading usage out of harness store lines (SPEC §10 Usage). One record per model request, with the
// tokens as the API bills them. Files are read a line at a time and incrementally (scan.ts), so each
// parser keeps what it needs between lines in the file's state. Only a line whose start has a
// parser's marker is decoded whole and parsed (`marks`): a huge tool output is never decoded.
//
// Claude Code writes one JSONL entry per content block of an assistant message, each carrying the
// message's usage (earlier blocks of a streamed message may carry less output): one request is one
// message id and request id, its counts the largest seen. A resumed or forked session can repeat
// another file's entries; the report merges them across files. A compaction's own request isn't in
// the store (only its boundary), so it isn't counted.
//
// Codex writes `token_usage_record` lines (one per response, by response id) on newer versions, and
// `token_count` events on all. Before a file's first record, each token_count whose running total
// moved is one response (`last_token_usage`); a repeat of the same total is the same report again.
// A fork's first total includes its parent's, which is why the total is only used to spot repeats.
// A token_count carrying a plan's limits (`rate_limits.plan_type`) marks the response it reports (the
// record just before it, or its own) as on the plan.

import type { HarnessId } from "../../../../shared/transcript";

/** [key, time (s), model, uncached input, output, cache read, cache write (short), cache write (long), flags] */
export type Rec = [key: string, t: number, model: string, input: number, output: number, cacheRead: number, w1: number, w2: number, flags: number];
/** Claude fast mode */
export const FAST = 1;
/** Claude US-only inference */
export const US_GEO = 2;
/** an OpenAI request over 272K input tokens */
export const LONG = 4;
/** a service tier other than standard: no price */
export const ODD_TIER = 8;
/** Codex: its token count carried a plan's limits */
export const PLAN = 16;
/** the entry names this file's own session (not a copy from another) */
export const OWN = 32;

export interface FileState {
  harness: HarnessId;
  size: number;
  mtime: number;
  /** bytes read, up to the end of the last whole line */
  offset: number;
  /** a hash of the file's first `headLen` bytes (≤ 256): a different file under the same name is read again */
  head: string;
  headLen?: number;
  /** the session the file belongs to (Claude: its main session, for a subagent's file too) */
  session?: string;
  /** the session's folder */
  project?: string;
  /** Codex: the thread's model provider */
  provider?: string;
  /** Codex: a private CODEX_HOME (a Tether API-key thread) */
  private?: boolean;
  /** Codex: the model of the newest turn_context, the service tier last applied, the running total, whether records are written, the newest record's index */
  model?: string;
  tier?: string;
  total?: number;
  records?: boolean;
  last?: number;
  recs: Rec[];
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const time = (ts: unknown) => {
  const t = typeof ts === "string" ? Date.parse(ts) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined;
};
export const keyOf = (s: string) => Bun.hash(s).toString(36);

/** Adds a record, or raises an earlier one with the same key to the larger counts (a streamed message's later entry). */
function put(f: FileState, index: Map<string, number>, r: Rec) {
  const at = index.get(r[0]);
  if (at === undefined) {
    index.set(r[0], f.recs.length);
    f.last = f.recs.length;
    f.recs.push(r);
    return;
  }
  merge(f.recs[at]!, r);
  f.last = at;
}
/** The larger counts of two copies of one request, and both's flags. */
export function merge(into: Rec, r: Rec) {
  for (let i = 3; i <= 7; i++) (into as any)[i] = Math.max(into[i] as number, r[i] as number);
  into[8] |= r[8];
}

/** How much of a line's start the markers are looked for in. */
export const HEAD = 2048;

/** Claude: an assistant entry's start names its model (newer) or its role (older) before its content. */
const claudeMarks = (head: string) => head.includes('"model":"') || head.includes('"assistant"');

export function claudeLine(line: string, f: FileState, index: Map<string, number>) {
  let e: any;
  try { e = JSON.parse(line); } catch { return; }
  if (e?.type !== "assistant") return;
  const m = e.message;
  const u = m?.usage;
  const model = m?.model;
  if (!u || typeof model !== "string" || !model || model.startsWith("<")) return;
  const t = time(e.timestamp);
  if (t === undefined) return;
  if (!f.project && typeof e.cwd === "string") f.project = e.cwd;
  const written = n(u.cache_creation_input_tokens);
  const long = Math.min(written, n(u.cache_creation?.ephemeral_1h_input_tokens));
  const flags = (u.speed === "fast" ? FAST : 0) | (u.inference_geo === "us" ? US_GEO : 0) | (u.service_tier == null || u.service_tier === "standard" ? 0 : ODD_TIER) |
    (e.sessionId === undefined || e.sessionId === f.session ? OWN : 0);
  const r: Rec = [keyOf(typeof m.id === "string" ? `${m.id}:${e.requestId ?? ""}` : `uuid:${e.uuid}`), t, model, n(u.input_tokens), n(u.output_tokens), n(u.cache_read_input_tokens), written - long, long, flags];
  if (r[3] + r[4] + r[5] + r[6] + r[7] === 0) return;
  put(f, index, r);
}

/** Codex's own tiers that are Standard; any other (flex, priority…) has no price here. */
const STANDARD_TIERS: unknown[] = [undefined, null, "", "default", "auto", "standard"];

/** An OpenAI usage object (input includes cached and written tokens) as a record. */
function codexRec(f: FileState, key: string, t: number, u: any, own: boolean): Rec | undefined {
  const input = n(u?.input_tokens), cached = n(u?.cached_input_tokens), writes = n(u?.cache_write_input_tokens), output = n(u?.output_tokens);
  if (!input && !output) return undefined;
  const flags = (input > 272_000 ? LONG : 0) | (STANDARD_TIERS.includes(f.tier) ? 0 : ODD_TIER) | (own ? OWN : 0);
  return [keyOf(key), t, f.model ?? "unknown", Math.max(0, input - cached - writes), output, cached, writes, 0, flags];
}

const CODEX_MARKS = ['"token_count"', '"token_usage_record"', '"turn_context"', '"session_meta"', '"thread_settings_applied"'];
const codexMarks = (head: string) => CODEX_MARKS.some((m) => head.includes(m));

export function codexLine(line: string, f: FileState, index: Map<string, number>) {
  let e: any;
  try { e = JSON.parse(line); } catch { return; }
  const p = e?.payload;
  if (!p || typeof p !== "object") return;
  if (e.type === "session_meta") {
    if (!f.session && typeof p.id === "string") f.session = p.id;
    if (!f.project && typeof p.cwd === "string") f.project = p.cwd;
    if (typeof p.model_provider === "string") f.provider = p.model_provider;
    return;
  }
  if (e.type === "turn_context") {
    if (typeof p.model === "string" && p.model) f.model = p.model;
    if (!f.project && typeof p.cwd === "string") f.project = p.cwd;
    return;
  }
  if (e.type === "event_msg" && p.type === "thread_settings_applied") {
    const tier = p.thread_settings?.service_tier;
    f.tier = typeof tier === "string" ? tier : undefined;
    return;
  }
  const t = time(e.timestamp);
  if (t === undefined) return;
  if (e.type === "token_usage_record") {
    f.records = true;
    const own = p.thread_id === undefined || !f.session || p.thread_id === f.session;
    const r = codexRec(f, `r:${p.response_id ?? `${t}:${p.thread_token_usage?.total_tokens}`}`, t, p.usage, own);
    if (r) put(f, index, r);
    return;
  }
  if (e.type !== "event_msg" || p.type !== "token_count") return;
  const plan = typeof p.rate_limits?.plan_type === "string" && !!p.rate_limits.plan_type;
  const info = p.info;
  const total = info?.total_token_usage?.total_tokens;
  if (typeof total === "number") {
    const repeat = total === f.total;
    f.total = total;
    if (!f.records && !repeat) {
      const r = codexRec(f, `t:${e.timestamp}:${total}`, t, info.last_token_usage, true);
      if (r) put(f, index, r);
    }
  }
  // The response this count reports: the record before it, or the one it just made.
  if (plan && f.last !== undefined && f.recs[f.last]) f.recs[f.last]![8] |= PLAN;
}

export const lineParser = (h: HarnessId) => (h === "claude" ? { marks: claudeMarks, parse: claudeLine } : { marks: codexMarks, parse: codexLine });
