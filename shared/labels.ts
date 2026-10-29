// Human labels for model ids, effort levels and permission modes (SPEC §2.6: "Opus 5.5", "High").
// The runner labels what a harness lists; the browser labels whatever a session reports.

import type { ModelOption } from "./transcript";

const FAMILIES = ["opus", "sonnet", "haiku", "fable"];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * "claude-opus-5-5" -> "Opus 5.5", "claude-haiku-4-5-20251001" -> "Haiku 4.5", "opus" -> "Opus",
 * "claude-sonnet-5[1m]" -> "Sonnet 5 (1M)". An id it doesn't recognize comes back as it is.
 */
export function prettyModel(id: string): string {
  const m = id.match(/^(?:claude-)?([a-z]+)((?:-\d+)*)(?:-\d{8})?(\[1m\])?$/i);
  if (!m || !FAMILIES.includes(m[1]!.toLowerCase())) return id;
  const version = m[2] ? m[2].slice(1).split("-").filter((p) => p.length < 8).join(".") : "";
  return `${cap(m[1]!.toLowerCase())}${version ? ` ${version}` : ""}${m[3] ? " (1M)" : ""}`;
}

/**
 * A model's label: the harness's own name for it when the list has it (by id or by what an alias
 * resolves to), else its id made readable. "default" reads as what it runs now when known.
 */
export function modelLabel(id: string | undefined, models: ModelOption[] = [], resolved?: string): string {
  if (!id) return "Default";
  const hit = models.find((m) => m.id === id) ?? models.find((m) => m.resolved === id && m.id !== "default");
  if (id === "default") {
    const runs = resolved ?? hit?.resolved;
    return runs ? `Default (${modelLabel(runs, models.filter((m) => m.id !== "default"))})` : "Default";
  }
  return hit?.label ?? prettyModel(id);
}

const EFFORTS: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
export const effortLabel = (e: string | undefined) => (e ? (EFFORTS[e] ?? cap(e)) : "Default");

const MODES: Record<string, string> = {
  default: "Ask first",
  acceptEdits: "Accept edits",
  plan: "Plan",
  bypassPermissions: "Bypass permissions",
  auto: "Auto",
  dontAsk: "Don't ask",
  // Codex's presets (runner/src/adapters/codex/modes.ts)
  "read-only": "Read only",
  untrusted: "Ask first",
  "full-access": "Full access",
};
export const permissionModeLabel = (m: string | undefined) => (m ? (MODES[m] ?? cap(m)) : "Ask first");
