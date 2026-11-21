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

export function modelList(config: any[]): ModelList {
  const efforts = options(config, "thought_level").map((e) => ({ id: e.value, label: e.name }));
  const takes = efforts.length ? { efforts: efforts.map((e) => e.id) } : {};
  const models = options(config, "model").map((m) => ({ id: m.value, label: m.name, ...takes }));
  return {
    // "Default": whatever Antigravity picks itself (its own setting, as its TUI shows it).
    models: models.length ? [{ id: "default", label: "Default", ...takes }, ...models] : [],
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
