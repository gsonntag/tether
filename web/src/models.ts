/**
 * Display names for model ids and effort levels. Display only: wire values (ids, levels) never
 * change. A small table covers ids a heuristic can't guess (aliases); everything else goes through
 * the heuristic, so new ids ("claude-opus-6", "gpt-7-codex", "us.anthropic.…-v1:0") still read well.
 */

import { parseEntry, type HarnessId } from "./shared/protocol";

export type ModelProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "meta"
  | "mistral"
  | "deepseek"
  | "moonshot"
  | "qwen"
  | "minimax"
  | "nvidia"
  | "zai"
  | "amazon";

export interface ModelDisplay {
  /** the raw id, unchanged */
  id: string;
  /** "Opus 5.5", "GPT-6 Luna", "Gemini 3.1 Pro" */
  name: string;
  provider?: ModelProvider;
  /** "Anthropic", "OpenAI", … */
  providerLabel?: string;
  /** /logos/*.svg, when there is one for the provider */
  logo?: string;
  /** the route the model is served through when it isn't the maker ("azure", "amazon-bedrock", "openai-codex") */
  via?: string;
}

export const PROVIDERS: Record<ModelProvider, { label: string; logo?: string }> = {
  anthropic: { label: "Anthropic", logo: "/logos/anthropic.svg" },
  openai: { label: "OpenAI", logo: "/logos/openai.svg" },
  google: { label: "Google", logo: "/logos/google.svg" },
  xai: { label: "xAI", logo: "/logos/xai.svg" },
  meta: { label: "Meta", logo: "/logos/meta.svg" },
  mistral: { label: "Mistral", logo: "/logos/mistral.svg" },
  deepseek: { label: "DeepSeek", logo: "/logos/deepseek.svg" },
  moonshot: { label: "Moonshot", logo: "/logos/moonshot.svg" },
  qwen: { label: "Qwen", logo: "/logos/qwen.svg" },
  minimax: { label: "MiniMax", logo: "/logos/minimax.svg" },
  nvidia: { label: "NVIDIA", logo: "/logos/nvidia.svg" },
  zai: { label: "Z.ai" },
  amazon: { label: "Amazon" },
};

/** Exact ids (after prefix stripping, lowercased) the heuristic can't name well. */
const KNOWN: Record<string, { name: string; provider?: ModelProvider }> = {
  default: { name: "Default" },
  opus: { name: "Opus", provider: "anthropic" },
  sonnet: { name: "Sonnet", provider: "anthropic" },
  haiku: { name: "Haiku", provider: "anthropic" },
  fable: { name: "Fable", provider: "anthropic" },
  opusplan: { name: "Opus Plan", provider: "anthropic" },
  best: { name: "Best", provider: "anthropic" },
  "gpt-daybreak-blue-latest": { name: "Daybreak Blue", provider: "openai" },
  "gpt-daybreak-red-latest": { name: "Daybreak Red", provider: "openai" },
  "gemini-flash-latest": { name: "Gemini Flash", provider: "google" },
  "gemini-flash-lite-latest": { name: "Gemini Flash Lite", provider: "google" },
};

/** Path/dot prefixes that name the maker ("anthropic/…", "us.anthropic.…"). */
const VENDOR_PREFIX: Record<string, ModelProvider> = {
  anthropic: "anthropic",
  openai: "openai",
  "openai-codex": "openai",
  google: "google",
  "google-vertex": "google",
  gemini: "google",
  xai: "xai",
  "x-ai": "xai",
  meta: "meta",
  "meta-llama": "meta",
  mistral: "mistral",
  mistralai: "mistral",
  deepseek: "deepseek",
  "deepseek-ai": "deepseek",
  moonshot: "moonshot",
  moonshotai: "moonshot",
  "moonshotai-cn": "moonshot",
  "kimi-coding": "moonshot",
  qwen: "qwen",
  alibaba: "qwen",
  minimax: "minimax",
  "minimax-cn": "minimax",
  nvidia: "nvidia",
  zai: "zai",
  "z-ai": "zai",
  "zai-coding-cn": "zai",
  amazon: "amazon",
};

/** Prefixes above that name a maker's own route rather than the maker (kept as `via`). */
const ROUTES = new Set(["openai-codex", "google-vertex", "moonshotai-cn", "kimi-coding", "minimax-cn", "zai-coding-cn"]);

/** First word of the model → maker and how the family is written. */
const FAMILIES: { re: RegExp; provider: ModelProvider; name?: string }[] = [
  { re: /^claude$/, provider: "anthropic" },
  { re: /^(opus|sonnet|haiku|fable)$/, provider: "anthropic" },
  { re: /^gpt$/, provider: "openai", name: "GPT" },
  { re: /^o\d+$/, provider: "openai" },
  { re: /^codex$/, provider: "openai" },
  { re: /^(gemini|gemma)$/, provider: "google" },
  { re: /^grok$/, provider: "xai" },
  { re: /^(llama|muse)$/, provider: "meta" },
  { re: /^(mistral|mixtral|ministral|magistral|devstral|codestral|pixtral|voxtral)$/, provider: "mistral" },
  { re: /^deepseek$/, provider: "deepseek", name: "DeepSeek" },
  { re: /^kimi$/, provider: "moonshot" },
  { re: /^(qwen|qwq)$/, provider: "qwen", name: "Qwen" },
  { re: /^minimax$/, provider: "minimax", name: "MiniMax" },
  { re: /^nemotron$/, provider: "nvidia" },
  { re: /^glm$/, provider: "zai", name: "GLM" },
  { re: /^nova$/, provider: "amazon" },
];

/** Families whose version hangs on with a hyphen ("GPT-5.5", "GLM-5.3") or nothing ("Qwen3.6"). */
const VERSION_JOIN: Record<string, string> = { gpt: "-", glm: "-", qwen: "" };

const UPPER = new Set(["gpt", "glm", "oss", "vl", "it", "ai", "mai", "a2a"]);
const EFFORT_SUFFIX = new Set(["minimal", "low", "medium", "high", "xhigh"]); // not "max": "qwen3.8-max" is a tier
const REGIONS = /^(us|eu|apac|au|jp|in|ca|global|us-gov)\./;

function title(w: string): string {
  if (UPPER.has(w)) return w.toUpperCase();
  if (/^o\d+$/.test(w)) return w; // OpenAI's o-series is lowercase
  if (/^\d+(\.\d+)?[bkmt]$/.test(w)) return w.toUpperCase(); // 70b → 70B
  if (/^[a-z]\d+(\.\d+)?[a-z]?$/.test(w)) return w.toUpperCase(); // k2.7 → K2.7, a22b → A22B, m2.7 → M2.7
  if (/^\d+x\d+b$/.test(w)) return w.slice(0, -1) + "B"; // 8x7b → 8x7B
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** "claude-opus-5-5" → "opus 5.5" style word list: dates and build tags dropped, split versions joined. */
function words(core: string): string[] {
  let s = core
    .replace(/-v?\d+:\d+$/, "") // bedrock "-v1:0", "-1:0"
    .replace(/-v1$/, "") // bedrock "claude-opus-4-6-v1"
    .replace(/:free$/, "-free")
    .replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, "") // -2025-05-14, -20250514
    .replace(/-(0[1-9]|1[0-2])-20\d{2}$/, "") // -10-2025
    .replace(/-latest$/, "");
  const raw = s.split(/[-_\s]+/).filter(Boolean);
  const out: string[] = [];
  for (const w of raw) {
    const prev = out[out.length - 1];
    // "4","5" → "4.5"; "llama3","1" → "llama3.1"; "k2","5" → "k2.5"
    if (prev && /^\d{1,2}$/.test(w) && /\d$/.test(prev) && !/\./.test(prev) && !/^\d+[bkmt]$/.test(prev)) out[out.length - 1] = `${prev}.${w}`;
    else out.push(w);
  }
  return out;
}

/** Splits a glued family+version word ("llama3.1" → ["llama", "3.1"], "qwen3" → ["qwen", "3"]). */
function unglue(w: string): [string, string] | undefined {
  const m = /^(llama|qwen|gemma|nova|glm|deepseek|grok|kimi|minimax)(\d[\w.]*)$/.exec(w);
  return m ? [m[1]!, m[2]!] : undefined;
}

/**
 * Pretty name, maker and logo for a model id, e.g. "claude-opus-5-5" → Opus 5.5 (Anthropic),
 * "openai-codex/gpt-6-luna" → GPT-6 Luna (OpenAI, via openai-codex). `harness` names the maker of
 * ids that don't (Claude Code's "default" is Anthropic's).
 */
export function modelDisplay(id: string | undefined, harness?: string): ModelDisplay {
  const rawId = id ?? "default";
  let rest = rawId.trim();
  let provider: ModelProvider | undefined;
  let via: string | undefined;

  // "[1m]" context tags → a "1M" suffix
  let ctx = "";
  rest = rest.replace(/\[(\d+[km])\]$/i, (_, c: string) => ((ctx = c.toUpperCase()), ""));

  // path prefixes: "openrouter/anthropic/claude-…", "amazon-bedrock/us.anthropic.claude-…"
  const parts = rest.split("/");
  rest = parts.pop()!;
  for (const p of parts.map((x) => x.toLowerCase().replace(/^~/, ""))) {
    provider ??= VENDOR_PREFIX[p];
    if (!VENDOR_PREFIX[p] || ROUTES.has(p)) via ??= p;
  }

  // dot prefixes: "us.anthropic.claude-…", "meta.llama3-…", "@cf/…"
  let lower = rest.toLowerCase().replace(REGIONS, "");
  const dot = /^([a-z][a-z-]*)\.(?=[a-z])/.exec(lower);
  if (dot) {
    provider ??= VENDOR_PREFIX[dot[1]!];
    lower = lower.slice(dot[0].length);
  }
  if (provider === "deepseek" && /^v\d/.test(lower)) lower = `deepseek-${lower}`; // bedrock "deepseek.v3"
  if (provider === "zai" || /^zai-/.test(lower)) lower = lower.replace(/^zai-/, "");

  const known = KNOWN[lower];
  if (known) return finish(rawId, known.name + (ctx ? ` ${ctx}` : ""), known.provider ?? provider ?? harnessProvider(harness), via);

  let ws = words(lower);
  if (!ws.length) return finish(rawId, rawId, provider, via);

  // family + maker
  const g = unglue(ws[0]!);
  if (g) ws = [g[0], g[1], ...ws.slice(1)];
  const fam = FAMILIES.find((f) => f.re.test(ws[0]!));
  provider ??= fam?.provider;

  // Claude: drop "claude", and put the tier first ("claude-3-5-sonnet" → "Sonnet 3.5")
  if (ws[0] === "claude") {
    ws = ws.slice(1);
    const tier = ws.findIndex((w) => /^(opus|sonnet|haiku|fable)$/.test(w));
    if (tier > 0) ws = [ws[tier]!, ...ws.slice(0, tier), ...ws.slice(tier + 1)];
  }

  // a trailing effort tag ("gemini-3.8-flash-high") reads as "(High)"
  let effort = "";
  if (ws.length > 2 && EFFORT_SUFFIX.has(ws[ws.length - 1]!)) effort = ` (${effortLabel(ws.pop()!)})`;

  const join = VERSION_JOIN[ws[0]!];
  const first = fam?.name ?? title(ws[0]!);
  let name: string;
  if (join !== undefined && ws[1] && (/^\d/.test(ws[1]) || ws[1] === "oss")) name = [first + join + title(ws[1]), ...ws.slice(2).map(title)].join(" ");
  else name = [first, ...ws.slice(1).map(title)].join(" ");
  name = name.replace(/ Free$/, " (free)");

  return finish(rawId, name + effort + (ctx ? ` ${ctx}` : ""), provider, via);
}

function harnessProvider(harness?: string): ModelProvider | undefined {
  if (harness === "claude-code") return "anthropic";
  if (harness === "codex") return "openai";
  if (harness === "antigravity") return "google";
  return undefined;
}

function finish(id: string, name: string, provider: ModelProvider | undefined, via: string | undefined): ModelDisplay {
  const p = provider && PROVIDERS[provider];
  return { id, name, provider, providerLabel: p?.label, logo: p?.logo, via };
}

/** "claude-code:opus → codex:gpt-6-luna" → "Opus → GPT-6 Luna". */
export function chainLabel(chain: string[], fallback: HarnessId = "claude-code"): string {
  const ds = chain.map((e) => {
    const { harness, model } = parseEntry(e, fallback);
    return modelDisplay(model || undefined, harness);
  });
  // The same model through two routes ("openai-codex/gpt-6-luna", "azure/gpt-6-luna") names its route.
  const twice = (name: string) => ds.filter((d) => d.name === name).length > 1;
  return ds.map((d) => (d.via && twice(d.name) ? `${d.name} (${d.via})` : d.name)).join(" → ");
}

const EFFORT_LABELS: Record<string, string> = { xhigh: "XHigh", "x-high": "XHigh", max: "Max", off: "Off", none: "None", minimal: "Minimal" };

/** "high" → "High", "xhigh" → "XHigh". Display only; send the raw level. */
export function effortLabel(level: string): string {
  const l = level.toLowerCase();
  return EFFORT_LABELS[l] ?? (l ? l.charAt(0).toUpperCase() + l.slice(1) : level);
}
