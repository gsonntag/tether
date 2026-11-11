// What the Home agent runs on (runner/src/modules/homeAgent): its harness, source and model, shown
// above its chat and changed from there. Kept on the runner for every chat; the current chat takes a
// change too (a harness or a Codex source by a move, which keeps the conversation).

import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Popover } from "@astryxdesign/core/Popover";
import { findModel, isApiBilling, modelLabel, prettyModel } from "../../../shared/labels";
import type { BillingSource, SourceChoices } from "../../../shared/credentials";
import type { HomeAgentSettings } from "../../../shared/protocol";
import { CLAUDE_UNSET, HARNESS_LABELS, type HarnessId, type ModelOption } from "../../../shared/transcript";
import { rpc } from "../connection";
import { loadModels, modelListKey, useStore } from "../store";
import { azureDeployments, DeploymentPicker, SourcePicker } from "./SourcePicker";

/** The model a harness runs with none picked, as the picker lists it. */
const unpickedOf = (harness: HarnessId, models: ModelOption[]) => (harness === "claude" ? (findModel(models, CLAUDE_UNSET.model)?.id ?? CLAUDE_UNSET.model) : "default");

/** The models to offer: the harness's list, or its default when there's none yet. */
const listedOf = (harness: HarnessId, models?: ModelOption[]): ModelOption[] =>
  models?.length ? models : harness === "claude" ? [{ id: CLAUDE_UNSET.model, label: prettyModel(CLAUDE_UNSET.model) }] : [{ id: "default", label: "Default" }];

function useSources(runnerId: string, harness: HarnessId, when: unknown) {
  const [sources, setSources] = useState<SourceChoices>();
  useEffect(() => {
    let gone = false;
    setSources(undefined);
    rpc(runnerId, "billingSources", { harness })
      .then((s) => !gone && setSources(s))
      .catch(() => !gone && setSources({ options: [] }));
    return () => void (gone = true);
  }, [runnerId, harness, when]);
  return sources;
}

export function HomeAgentSettingsChip({ runnerId, settings, harnesses, onChanged }: { runnerId: string; settings: HomeAgentSettings; harnesses: HarnessId[]; onChanged: (r: { sessionId?: string; settings: HomeAgentSettings; rev: number }) => void }) {
  const [open, setOpen] = useState(false);
  const models = useStore((s) => s.modelLists[modelListKey(runnerId, settings.harness)]);
  const sources = useSources(runnerId, settings.harness, settings.source);
  useEffect(() => {
    if (!models) void loadModels(runnerId, settings.harness);
  }, [runnerId, settings.harness]);
  const billing = sources?.options.find((o) => o.source === settings.source)?.billing;
  const listed = listedOf(settings.harness, models?.models);
  const model = settings.model ? modelLabel(settings.model, listed) : modelLabel(unpickedOf(settings.harness, listed), listed);
  return (
    <Popover
      isOpen={open}
      onOpenChange={setOpen}
      width={340}
      label="Home agent settings"
      placement="below"
      alignment="end"
      content={
        open ? (
          <HomeAgentForm
            runnerId={runnerId}
            settings={settings}
            harnesses={harnesses}
            onDone={(r) => {
              setOpen(false);
              onChanged(r);
            }}
          />
        ) : null
      }
    >
      <button type="button" className="t-home-agent-chip" aria-label="Home agent: model and source">
        <span>{HARNESS_LABELS[settings.harness]}</span>
        <span className="t-home-agent-sep">·</span>
        <span>{model}</span>
        <span className="t-home-agent-sep">·</span>
        <span className={billing && isApiBilling(billing) ? "t-move-api" : undefined}>{billing?.label ?? (sources ? "Unavailable" : "…")}</span>
        <span aria-hidden className="t-home-agent-chev">▾</span>
      </button>
    </Popover>
  );
}

function HomeAgentForm({ runnerId, settings, harnesses, onDone }: { runnerId: string; settings: HomeAgentSettings; harnesses: HarnessId[]; onDone: (r: { sessionId?: string; settings: HomeAgentSettings; rev: number }) => void }) {
  const [harness, setHarness] = useState<HarnessId>(settings.harness);
  const [source, setSource] = useState<BillingSource | undefined>(settings.source);
  const [model, setModel] = useState<string>(settings.model ?? "default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const models = useStore((s) => s.modelLists[modelListKey(runnerId, harness)]);
  const sources = useSources(runnerId, harness, undefined);
  useEffect(() => {
    if (!models) void loadModels(runnerId, harness);
  }, [runnerId, harness]);

  const options = sources?.options ?? [];
  // A source this harness doesn't have (another harness's, or a key since unset): its first instead.
  const picked = options.find((o) => o.source === source) ?? options.find((o) => o.source === sources?.default) ?? options[0];
  const deployments = azureDeployments(picked);
  const listed = listedOf(harness, models?.models);
  const modelOk = listed.some((m) => m.id === model);
  const shownModel = deployments ? ((deployments.find((d) => d.name === model) ?? deployments[0])?.name ?? "") : modelOk && model !== "default" ? model : unpickedOf(harness, listed);

  const apply = async () => {
    // A runner without sources has only its harness's own login.
    const src = picked?.source ?? (sources && !options.length ? "subscription" : undefined);
    if (!src) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await rpc(runnerId, "homeAgentSet", { harness, source: src, ...(shownModel && shownModel !== "default" ? { model: shownModel } : {}) });
      onDone(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="t-form t-home-agent-form">
      {harnesses.length > 1 && (
        <div className="t-seg" role="radiogroup" aria-label="Agent">
          {harnesses.map((h) => (
            <button
              type="button"
              role="radio"
              aria-checked={h === harness}
              key={h}
              className={`t-seg-opt${h === harness ? " on" : ""}`}
              onClick={() => {
                setHarness(h);
                setModel(h === settings.harness ? (settings.model ?? "default") : "default");
                setSource(h === settings.harness ? settings.source : undefined);
              }}
            >
              {HARNESS_LABELS[h]}
            </button>
          ))}
        </div>
      )}
      {sources && !options.length ? (
        <div>
          <span className="t-field-label">Source</span>
          <div>{HARNESS_LABELS[harness]}'s own login</div>
        </div>
      ) : (
        <SourcePicker choices={sources} value={picked?.source} onChange={setSource} />
      )}
      {deployments ? (
        <DeploymentPicker deployments={deployments} value={shownModel} onChange={setModel} />
      ) : (
        <label>
          <span className="t-field-label">Model</span>
          <select className="t-select" value={shownModel} onChange={(e) => setModel(e.target.value)}>
            {listed.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id === "default" ? modelLabel("default", models?.models) : m.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {(harness !== settings.harness || (harness === "codex" && !!picked && picked.source !== settings.source)) && <span className="t-inline-status">The conversation moves to a new chat on {HARNESS_LABELS[harness]}.</span>}
      {error && <div className="t-form-error">{error}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button label={busy ? "Applying…" : "Apply"} variant="primary" size="sm" isDisabled={busy || !sources} onClick={() => void apply()} />
      </div>
    </div>
  );
}
