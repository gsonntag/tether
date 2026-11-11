// What the Home agent runs on (runner/src/modules/homeAgent): its model, source and mode, as the
// session page's own pickers (ChoiceMenu, BillingChip) above its chat, plus its agent when the
// runner has more than one. A pick applies at once, as on a session: kept on the runner for every
// chat, and the current chat takes it too (a harness or a Codex source by a move, which keeps the
// conversation).

import { useEffect, useState } from "react";
import { findModel, modelLabel, permissionModeLabel } from "../../../shared/labels";
import type { BillingSource } from "../../../shared/credentials";
import { HOME_AGENT_MODE, type HomeAgentSettings } from "../../../shared/protocol";
import { CLAUDE_UNSET, HARNESS_LABELS, type HarnessId, type LiveState, type ModelOption, type SessionSummary } from "../../../shared/transcript";
import { rpc } from "../connection";
import { loadModels, modelListKey, useStore } from "../store";
import { BillingChip, useSources } from "./BillingChip";
import { ChoiceMenu } from "./ChoiceMenu";
import { WatchAllToggle } from "./HomeAgentWatch";

type Changed = { sessionId?: string; settings: HomeAgentSettings; rev: number };

/** The model a harness runs with none picked, as the picker lists it. */
export const unpickedOf = (harness: HarnessId, models: ModelOption[]) => (harness === "claude" ? (findModel(models, CLAUDE_UNSET.model)?.id ?? CLAUDE_UNSET.model) : "default");

/** The settings with `patch` applied: another agent starts on its default source and model, and auto. */
export function nextSettings(settings: HomeAgentSettings, patch: Partial<HomeAgentSettings>, defaultSource?: BillingSource): HomeAgentSettings {
  if (patch.harness && patch.harness !== settings.harness) return { harness: patch.harness, source: patch.source ?? defaultSource ?? "subscription", mode: HOME_AGENT_MODE };
  const next = { ...settings, ...patch };
  // Another source's models are its own (Azure's deployments): the runner picks its first.
  if (patch.source && patch.source !== settings.source && !patch.model) delete next.model;
  return next;
}

export function HomeAgentPickers({ runnerId, settings, harnesses, onChanged, onError }: { runnerId: string; settings: HomeAgentSettings; harnesses: HarnessId[]; onChanged: (r: Changed) => void; onError: (message?: string) => void }) {
  const [busy, setBusy] = useState(false);
  const { harness } = settings;
  const models = useStore((s) => s.modelLists[modelListKey(runnerId, harness)]);
  const { choices: sources, refresh: refreshSources } = useSources(runnerId, harness, true);
  const ensureModels = () => void (models ? undefined : loadModels(runnerId, harness));
  useEffect(ensureModels, [runnerId, harness]);

  const option = sources?.options.find((o) => o.source === settings.source);
  const onAzure = settings.source === "azure";
  const azureModels = option?.deployments?.map((d) => ({ id: d.name, label: d.model ? `${d.name} · ${d.model}` : d.name, description: undefined }));
  const listed = models?.models ?? [];
  const model = settings.model ?? (onAzure ? (azureModels?.[0]?.id ?? "") : unpickedOf(harness, listed));
  const mode = settings.mode ?? HOME_AGENT_MODE;
  // The source chip reads a session: this one is what the Home agent would run on.
  const session: SessionSummary = { id: "home", harness, nativeId: "home", projectPath: "", title: "Home agent", mode: "stored", status: "idle", updatedAt: 0 };
  const state: LiveState = { mode: "stored", status: "idle", requests: [], queue: [], ...(option ? { billing: option.billing } : {}) } as LiveState;

  const apply = async (patch: Partial<HomeAgentSettings>) => {
    setBusy(true);
    onError(undefined);
    try {
      const other = patch.harness && patch.harness !== harness ? await rpc(runnerId, "billingSources", { harness: patch.harness }).catch(() => undefined) : undefined;
      const r = await rpc(runnerId, "homeAgentSet", nextSettings(settings, patch, other?.default ?? other?.options[0]?.source));
      onChanged(r);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy ? "Applying…" : undefined;

  return (
    <div className="t-chips t-home-agent-pickers" aria-label="Home agent settings" role="group">
      {harnesses.length > 1 && (
        <ChoiceMenu name="Agent" value={harness} label={HARNESS_LABELS[harness]} disabled={disabled} choices={harnesses.map((h) => ({ id: h, label: HARNESS_LABELS[h] }))} onPick={(h) => h !== harness && void apply({ harness: h as HarnessId })} />
      )}
      <ChoiceMenu
        name="Model"
        customLabel={harness === "codex" ? "Other model or deployment…" : undefined}
        value={model}
        label={model ? modelLabel(model, onAzure ? azureModels : listed) : "…"}
        disabled={disabled}
        choices={(onAzure ? (azureModels ?? []) : listed).map((m) => ({ id: m.id, label: m.label, description: m.description }))}
        onOpen={() => (ensureModels(), onAzure && refreshSources())}
        onPick={(m) => m !== model && void apply({ model: m })}
      />
      {sources && sources.options.length > 0 ? (
        <BillingChip runnerId={runnerId} session={session} state={state} standalone onSwitch={(source) => source !== settings.source && void apply({ source })} />
      ) : (
        <span className="t-chip t-chip-info">{sources ? `${HARNESS_LABELS[harness]}'s own login` : "…"}</span>
      )}
      <ChoiceMenu name="Mode" value={mode} label={permissionModeLabel(mode)} disabled={disabled} choices={models?.permissionModes ?? []} onOpen={ensureModels} onPick={(m) => m !== mode && void apply({ mode: m })} />
      <WatchAllToggle runnerId={runnerId} />
    </div>
  );
}
