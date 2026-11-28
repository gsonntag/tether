import { resolveSourceModel, type BillingSource, type SourceChoices } from "./credentials";
import type { HarnessId, ModelList } from "./transcript";

export interface FallbackStep {
  harness: HarnessId;
  source: BillingSource;
  model: string;
  effort?: string;
  permissionMode?: string;
}

export interface FallbackChain {
  enabled: boolean;
  continueOnReset?: boolean;
  steps: FallbackStep[];
  active?: number;
}

export interface FallbackPreset {
  id: string;
  name: string;
  steps: FallbackStep[];
}

export type FallbackPresetEdit =
  | { action: "save"; name: string; steps: FallbackStep[] }
  | { action: "rename"; id: string; name: string }
  | { action: "delete"; id: string };

export interface FallbackHarness {
  harness: HarnessId;
  sources: SourceChoices["options"];
  unavailable?: boolean;
  models?: ModelList;
  defaultMode?: string;
}

export interface FallbackSetup {
  chain: FallbackChain;
  saved: boolean;
  presets: FallbackPreset[];
  harnesses: FallbackHarness[];
}

export function fallbackStepProblem(step: FallbackStep, catalog?: FallbackHarness): string | undefined {
  if (!catalog || catalog.unavailable) return "Harness unavailable on this runner.";
  const source = catalog.sources.find((option) => option.source === step.source);
  if (!source) return "Login or key unavailable.";
  if (!catalog.models) return "Could not load models and permissions.";
  const model = catalog.models.models.find((option) => option.id === step.model);
  if (step.source === "azure") {
    if (!source.deployments?.some((option) => option.name === step.model)) return "Azure deployment unavailable.";
  } else if (step.source === "bedrock") {
    if (!resolveSourceModel(source.deployments ?? [], step.model)) return "Not set up on Bedrock.";
  } else if (!model) {
    return "Model unavailable.";
  }
  const effortModel = model ?? (step.source === "bedrock"
    ? catalog.models.models.find((option) => option.id === source.deployments?.find((d) => d.name === step.model)?.model)
    : undefined);
  if (step.effort && (!catalog.models.efforts?.some((option) => option.id === step.effort) ||
    (effortModel?.efforts && !effortModel.efforts.includes(step.effort)))) return "Effort unavailable for this model.";
  if (step.permissionMode ? !catalog.models.permissionModes?.some((mode) => mode.id === step.permissionMode) : !catalog.defaultMode) {
    return "No permission mode within this session's access.";
  }
}

export const FALLBACK_BACKOFF_MS = 10 * 60_000;

/** Why a step was backed off, persisted so the UI can distinguish limits from transient errors. */
export type FallbackStepWhy = "limit" | "limit-unknown-reset" | "error";

/** Runner-local progress keyed by the index in the saved order. */
export interface FallbackProgress {
  lastUserText?: string;
  steps: Record<number, { retryAt?: number; why?: FallbackStepWhy; sessionId?: string; after?: string }>;
}

export function fallbackOrder(length: number, current: number, progress: FallbackProgress, now: number, returning = false): number[] {
  return Array.from({ length }, (_, index) => index).filter((index) =>
    index !== current && (!returning || index < current) && (progress.steps[index]?.retryAt ?? 0) <= now);
}
