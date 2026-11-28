// Antigravity's models, thinking levels and permission modes, as it offers them over ACP
// (`configOptions`): a model is a family ("gemini-3.8-flash"), its thinking level a setting of its own.

import { UNKNOWN_BILLING, type Billing, type ModelList } from "../../../../shared/transcript";
import { lastTier } from "./store";

const options = (config: any[], id: string): { value: string; name: string; description?: string }[] => {
  const o = config.find((c) => c?.id === id || c?.category === id);
  return (Array.isArray(o?.options) ? o.options : [])
    .filter((x: any) => typeof x?.value === "string")
    .map((x: any) => ({ value: x.value, name: typeof x.name === "string" ? x.name : x.value, ...(typeof x.description === "string" ? { description: x.description } : {}) }));
};

/**
 * Tether's own mode, not one of Antigravity's: Antigravity runs in `accept-edits` and the driver
 * approves every request itself (a subagent's too), so nothing asks. Questions still come to you.
 */
export const BYPASS = "bypassPermissions";

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_LABELS: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra", max: "Max" };

/**
 * Derives per-model supported efforts from ACP `models.availableModels` (e.g. `gemini-4-neon-high`
 * -> model `gemini-4-neon` supports `high`). Models with no `-<effort>` variants take no effort.
 */
function effortsByModel(
  modelIds: string[],
  availableModels: { modelId?: string; name?: string }[],
  knownEffortLabels: Map<string, string>,
): { byModel: Map<string, string[]>; allEfforts: { id: string; label: string }[] } {
  const known = new Set([...EFFORT_ORDER, ...knownEffortLabels.keys()]);
  const ids = availableModels.map((m) => m?.modelId).filter((x): x is string => typeof x === "string" && x.length > 0);
  const byModel = new Map<string, string[]>();
  const discovered = new Set<string>();
  const rank = (e: string) => {
    const i = EFFORT_ORDER.indexOf(e);
    return i >= 0 ? i : EFFORT_ORDER.length;
  };
  for (const id of modelIds) {
    const prefix = `${id}-`;
    const matched = ids
      .filter((v) => v.startsWith(prefix))
      .map((v) => v.slice(prefix.length))
      .filter((suffix) => known.has(suffix));
    const unique = [...new Set(matched)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    if (unique.length) {
      byModel.set(id, unique);
      for (const e of unique) discovered.add(e);
    }
  }
  const allIds = [...new Set([...knownEffortLabels.keys(), ...discovered])].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const allEfforts = allIds.map((id) => ({ id, label: knownEffortLabels.get(id) ?? EFFORT_LABELS[id] ?? id }));
  return { byModel, allEfforts };
}

export function modelList(config: any[], availableModels?: { modelId?: string; name?: string }[]): ModelList {
  const configEfforts = options(config, "thought_level").map((e) => ({ id: e.value, label: e.name }));
  const rawModels = options(config, "model");
  const hasVariants = Array.isArray(availableModels) && availableModels.length > 0;
  let efforts = configEfforts;
  let models: ModelList["models"];
  if (hasVariants) {
    const { byModel, allEfforts } = effortsByModel(
      rawModels.map((m) => m.value),
      availableModels,
      new Map(configEfforts.map((e) => [e.id, e.label])),
    );
    efforts = allEfforts;
    models = rawModels.map((m) => {
      const mEfforts = byModel.get(m.value);
      return { id: m.value, label: m.name, ...(mEfforts?.length ? { efforts: mEfforts } : {}) };
    });
  } else {
    const takes = efforts.length ? { efforts: efforts.map((e) => e.id) } : {};
    models = rawModels.map((m) => ({ id: m.value, label: m.name, ...takes }));
  }
  const defaultTakes = efforts.length ? { efforts: efforts.map((e) => e.id) } : {};
  return {
    // "Default": whatever Antigravity picks itself (its own setting, as its TUI shows it).
    models: models.length ? [{ id: "default", label: "Default", ...defaultTakes }, ...models] : [],
    efforts,
    permissionModes: ((modes) => (modes.length ? [...modes, { id: BYPASS, label: "Bypass permissions", description: "Tether approves every request itself: nothing asks." }] : modes))(
      options(config, "mode").map((m) => ({ id: m.value, label: m.value === "default" ? "Ask first" : m.name, ...(m.description ? { description: m.description } : {}) })),
    ),
  };
}

/** What sessions draw from: the Google account's plan, named as Antigravity names its tier ("Google AI Pro"). */
export function billingOf(): Billing {
  return lastTier ? { kind: "plan", label: lastTier } : UNKNOWN_BILLING;
}
