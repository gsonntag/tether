// Codex's models, effort levels and permission modes, with human labels (SPEC §2.6, §7).
//
// Codex has two permission settings: an approval policy (when to ask) and a sandbox (what commands
// may touch). Tether offers them as one menu of the presets Codex's own TUI offers (/approvals),
// plus "untrusted" (ask before anything outside Codex's own list of safe commands). Approvals are
// always routed to the client (`approvalsReviewer: "user"`), so they reach Tether's broker rather
// than Codex's automatic reviewer.

import { effortLabel } from "../../../../shared/labels";
import type { Choice, ModelList, ModelOption } from "../../../../shared/transcript";

export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexMode {
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
}

export const CODEX_MODES: Record<string, CodexMode & Choice> = {
  "read-only": { id: "read-only", label: "Read only", description: "Codex reads files; it asks before editing or running anything else", approvalPolicy: "on-request", sandbox: "read-only" },
  untrusted: { id: "untrusted", label: "Ask first", description: "Codex asks before any edit and any command outside its list of safe ones", approvalPolicy: "untrusted", sandbox: "workspace-write" },
  auto: { id: "auto", label: "Auto", description: "Codex edits and runs commands in this folder; it asks to go outside it or online", approvalPolicy: "on-request", sandbox: "workspace-write" },
  "full-access": { id: "full-access", label: "Full access", description: "Everything goes ahead without asking, outside the folder and online too", approvalPolicy: "never", sandbox: "danger-full-access" },
};

export const DEFAULT_MODE = "auto";

export const modeChoices = (): Choice[] => Object.values(CODEX_MODES).map(({ id, label, description }) => ({ id, label, description }));

const POLICIES = new Set(["untrusted", "on-request", "never"]);
const SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);

/**
 * A mode id's settings: a preset, or a thread's own combination none of them matches
 * ("never+read-only", from modeOf). An unknown id falls back to the default.
 */
export function codexMode(id: string | undefined): CodexMode {
  const preset = CODEX_MODES[id ?? ""];
  if (preset) return preset;
  const [a, s] = (id ?? "").split("+");
  if (a && s && POLICIES.has(a) && SANDBOXES.has(s)) return { approvalPolicy: a as ApprovalPolicy, sandbox: s as SandboxMode };
  return CODEX_MODES[DEFAULT_MODE]!;
}

/** The sandbox as thread/settings/update takes it. */
export function sandboxPolicy(s: SandboxMode) {
  if (s === "read-only") return { type: "readOnly", networkAccess: false };
  if (s === "danger-full-access") return { type: "dangerFullAccess" };
  return { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

/** The sandbox a policy object (or mode string) describes. */
export function sandboxOf(p: any): SandboxMode | undefined {
  const t = typeof p === "string" ? p : p?.type;
  if (t === "readOnly" || t === "read-only") return "read-only";
  if (t === "workspaceWrite" || t === "workspace-write") return "workspace-write";
  if (t === "dangerFullAccess" || t === "danger-full-access") return "danger-full-access";
  return undefined;
}

/**
 * The mode a thread's settings are: one of the presets, or their own combination as
 * "<policy>+<sandbox>" (shown as it is, and never loosened to a preset). Undefined when unknown.
 */
export function modeOf(approvalPolicy: unknown, sandbox: unknown): string | undefined {
  const sb = sandboxOf(sandbox);
  if (typeof approvalPolicy !== "string" || !POLICIES.has(approvalPolicy) || !sb) return undefined;
  return Object.values(CODEX_MODES).find((m) => m.approvalPolicy === approvalPolicy && m.sandbox === sb)?.id ?? `${approvalPolicy}+${sb}`;
}

/** A model as model/list returns it. */
export interface CodexModel {
  id: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: { reasoningEffort: string }[];
  defaultReasoningEffort?: string;
}

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** model/list as Tether's picker shows it: the default first, then each visible model. */
export function modelList(models: CodexModel[]): ModelList {
  const visible = models.filter((m) => !m.hidden);
  const efforts = (m: CodexModel) => (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort);
  const def = visible.find((m) => m.isDefault);
  const opts: ModelOption[] = visible.map((m) => ({
    id: m.id,
    label: m.displayName || m.id,
    ...(m.description ? { description: m.description } : {}),
    ...(efforts(m).length ? { efforts: efforts(m) } : {}),
  }));
  if (def) opts.unshift({ id: "default", label: `Default (${def.displayName || def.id})`, resolved: def.id, ...(efforts(def).length ? { efforts: efforts(def) } : {}) });
  const all = new Set(visible.flatMap(efforts));
  const ids = EFFORT_ORDER.filter((e) => all.has(e)).concat([...all].filter((e) => !EFFORT_ORDER.includes(e)));
  return { models: opts, efforts: ids.map((id) => ({ id, label: effortLabel(id) })), permissionModes: modeChoices() };
}
