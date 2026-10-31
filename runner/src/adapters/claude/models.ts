// The models, effort levels and permission modes Claude Code offers, with human labels. A live
// session asks its own process; otherwise a throwaway process is asked (no prompt, nothing saved)
// and the answer kept for an hour, since what an alias resolves to changes with releases.

import { query, type ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import { effortLabel, findModel, prettyModel } from "../../../../shared/labels";
import { CLAUDE_UNSET, type Choice, type ModelList, type ModelOption } from "../../../../shared/transcript";
import { CLAUDE_BIN } from "./bin";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Only when Claude Code can't list its models. */
const FALLBACK: ModelOption[] = [
  { id: "opus", label: "Opus", resolved: CLAUDE_UNSET.model },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

const MODES: Choice[] = [
  { id: "default", label: "Ask first", description: "Claude asks before editing files or running commands" },
  { id: "acceptEdits", label: "Accept edits", description: "File edits go ahead; commands still ask" },
  { id: "plan", label: "Plan", description: "Claude plans without changing anything" },
  { id: "bypassPermissions", label: "Bypass permissions", description: "Everything goes ahead without asking" },
  { id: "dontAsk", label: "Don't ask", description: "Only what your Claude settings allow runs; anything else is declined without asking" },
];
const AUTO: Choice = { id: "auto", label: "Auto", description: "Claude decides what needs asking" };

/** Claude Code's model list as Tether shows it. */
export function modelList(infos: ModelInfo[]): ModelList {
  // Not its "default" entry: nothing in Tether runs on Claude Code's own default (CLAUDE_UNSET).
  const models: ModelOption[] = infos
    .filter((m) => m.value !== "default")
    .map((m) => {
      const resolved = m.resolvedModel && m.resolvedModel !== m.value ? m.resolvedModel : undefined;
      return {
        id: m.value,
        label: m.displayName || prettyModel(m.value),
        ...(m.description ? { description: m.description } : {}),
        ...(resolved ? { resolved } : {}),
        // Empty: the model has no effort (Haiku 4.5).
        efforts: (m.supportsEffort && m.supportedEffortLevels) || [],
      };
    });
  // Offered even when Claude Code doesn't list it: it's what runs, or what it refuses.
  if (!findModel(models, CLAUDE_UNSET.model)) models.unshift({ id: CLAUDE_UNSET.model, label: prettyModel(CLAUDE_UNSET.model) });
  const efforts = EFFORTS.filter((e) => infos.some((m) => m.supportedEffortLevels?.includes(e as any))).map((id) => ({ id, label: effortLabel(id) }));
  const auto = infos.some((m) => m.supportsAutoMode);
  return { models, efforts: efforts.length ? efforts : EFFORTS.map((id) => ({ id, label: effortLabel(id) })), permissionModes: auto ? [...MODES, AUTO] : MODES };
}

let cache: { at: number; list: ModelList } | undefined;
let fetching: Promise<ModelList | undefined> | undefined;
const CACHE_MS = 60 * 60_000;

async function fetchModels(): Promise<ModelList | undefined> {
  async function* idle(): AsyncGenerator<never> {
    await new Promise(() => {});
  }
  const q = query({ prompt: idle(), options: { cwd: homedir(), persistSession: false, settingSources: [], tools: [], pathToClaudeCodeExecutable: CLAUDE_BIN } as any });
  try {
    const infos = await Promise.race([q.supportedModels(), Bun.sleep(20_000).then(() => Promise.reject(new Error("timed out")))]);
    return infos.length ? modelList(infos) : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      q.close();
    } catch {}
  }
}

/** The list: from a live session's process when given one, else cached. */
export async function claudeModels(live?: () => Promise<ModelInfo[]>): Promise<ModelList> {
  if (live) {
    try {
      const infos = await live();
      if (infos.length) {
        cache = { at: Date.now(), list: modelList(infos) };
        return cache.list;
      }
    } catch {}
  }
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    fetching ??= fetchModels().finally(() => (fetching = undefined));
    const list = await fetching;
    // A failure isn't retried on every call either.
    cache = { at: Date.now(), list: list ?? cache?.list ?? { models: FALLBACK, efforts: EFFORTS.map((id) => ({ id, label: effortLabel(id) })), permissionModes: MODES } };
  }
  return cache.list;
}
