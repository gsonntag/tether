import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { fallbackStepProblem, type FallbackHarness, type FallbackPresetEdit, type FallbackSetup, type FallbackStep } from "../../../shared/fallbackChain";
import { HARNESS_LABELS, type Choice } from "../../../shared/transcript";
import { rpc } from "../connection";

function Field({ label, value, options, empty, onChange }: {
  label: string; value: string; options: Choice[]; empty: ReactNode; onChange: (value: string) => void;
}) {
  return <label className="t-fallback-field">{label}
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {value && !options.some(({ id }) => id === value) && <option value={value}>{value} (unavailable)</option>}
      {options.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
    </select>
  </label>;
}

function modelsFor(catalog: FallbackHarness | undefined, source: string): Choice[] {
  if (source === "azure") return catalog?.sources.find((entry) => entry.source === source)?.deployments?.map(({ name, model }) => ({
    id: name, label: model ? `${name} · ${model}` : name,
  })) ?? [];
  return catalog?.models?.models ?? [];
}

function newStep(catalog: FallbackHarness, source = catalog.sources[0]?.source ?? "subscription"): FallbackStep {
  return { harness: catalog.harness, source, model: modelsFor(catalog, source)[0]?.id ?? "" };
}

export function FallbackChainDialog({ runnerId, sessionId, onClose }: { runnerId: string; sessionId: string; onClose: () => void }) {
  const [setup, setSetup] = useState<FallbackSetup>();
  const [steps, setSteps] = useState<FallbackStep[]>([]);
  const [continueOnReset, setContinueOnReset] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [presetId, setPresetId] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    let open = true;
    rpc(runnerId, "fallbackSetup", { sessionId }).then((result) => {
      if (!open) return;
      setSetup(result);
      setSteps(result.chain.steps);
      setEnabled(result.chain.enabled || !result.saved);
      setContinueOnReset(!!result.chain.continueOnReset);
    }, (e: Error) => { if (open) setError(e.message); });
    return () => { open = false; };
  }, [runnerId, sessionId]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try { await action(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const editPreset = (edit: FallbackPresetEdit) => void run(async () => {
    const presets = await rpc(runnerId, "editFallbackPreset", edit);
    setSetup((old) => old && { ...old, presets });
    if (edit.action === "delete") { setPresetId(""); setName(""); }
    if (edit.action === "save") setPresetId(presets.at(-1)?.id ?? "");
  });
  const move = (index: number, offset: number) => setSteps((old) => {
    const next = [...old];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    return next;
  });
  const incomplete = steps.some((step) => !step.model);
  const first = setup?.harnesses.find((entry) => entry.sources.length) ?? setup?.harnesses[0];
  return <Dialog isOpen onOpenChange={(open) => !open && !busy && onClose()} width={560} purpose="form">
    <DialogHeader title="Fallback chain" onOpenChange={(open) => !open && !busy && onClose()} />
    <div className="t-form t-fallback-editor">
      {!setup && !error && <p role="status">Loading fallback chain…</p>}
      {setup && <fieldset disabled={busy}>
        <label className="t-check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enable for this session</label>
        <label className="t-check"><input type="checkbox" checked={continueOnReset} disabled={!enabled} onChange={(e) => setContinueOnReset(e.target.checked)} /> Continue when a limit resets</label>
        <Field label="Runner presets" value={presetId} empty="Choose a preset" options={setup.presets.map(({ id, name: label }) => ({ id, label }))} onChange={(id) => {
          setPresetId(id);
          setName(setup.presets.find((preset) => preset.id === id)?.name ?? "");
        }} />
        <button type="button" disabled={!presetId} onClick={() => {
          const preset = setup.presets.find(({ id }) => id === presetId);
          if (preset) setSteps(preset.steps);
        }}>Load preset</button>
        <label className="t-fallback-field">Preset name<input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
        <div className="t-fallback-actions">
          <button type="button" disabled={!name.trim() || !steps.length || incomplete} onClick={() => editPreset({ action: "save", name, steps })}>Save as preset</button>
          <button type="button" disabled={!presetId || !name.trim()} onClick={() => editPreset({ action: "rename", id: presetId, name })}>Rename</button>
          <button type="button" disabled={!presetId} onClick={() => editPreset({ action: "delete", id: presetId })}>Delete</button>
        </div>
        <ol className="t-fallback-steps" aria-label="Steps in priority order">
          {steps.map((step, index) => {
            const catalog = setup.harnesses.find(({ harness }) => harness === step.harness);
            const model = catalog?.models?.models.find(({ id }) => id === step.model);
            const efforts = catalog?.models?.efforts.filter(({ id }) => !model?.efforts || model.efforts.includes(id)) ?? [];
            const modes = catalog?.models?.permissionModes ?? [];
            const problem = fallbackStepProblem(step, catalog);
            const change = (next: FallbackStep) => setSteps((old) => old.map((entry, i) => i === index ? next : entry));
            return <li key={index}>
              <div className="t-fallback-actions">
                <button type="button" aria-label={`Move step ${index + 1} up`} disabled={!index} onClick={() => move(index, -1)}>↑</button>
                <button type="button" aria-label={`Move step ${index + 1} down`} disabled={index === steps.length - 1} onClick={() => move(index, 1)}>↓</button>
                <button type="button" aria-label={`Remove step ${index + 1}`} onClick={() => setSteps((old) => old.filter((_, i) => i !== index))}>Remove</button>
              </div>
              <Field label="Harness" value={step.harness} empty="Choose a harness" options={setup.harnesses.filter((entry) => !entry.unavailable).map(({ harness }) => ({ id: harness, label: HARNESS_LABELS[harness] }))} onChange={(id) => {
                const target = setup.harnesses.find(({ harness }) => harness === id);
                if (target) change(newStep(target));
              }} />
              <Field label="Login or key" value={step.source} empty="Choose a source" options={catalog?.sources.map(({ source, billing }) => ({ id: source, label: billing.label })) ?? []} onChange={(id) => {
                const source = catalog?.sources.find((entry) => entry.source === id)?.source;
                if (source && catalog) change(newStep(catalog, source));
              }} />
              <Field label="Model" value={step.model} empty="Choose a model" options={modelsFor(catalog, step.source)} onChange={(model) => change({ ...step, model, effort: undefined })} />
              <Field label="Effort" value={step.effort ?? ""} empty="Harness default" options={efforts} onChange={(effort) => change({ ...step, effort: effort || undefined })} />
              <Field label="Permission mode" value={step.permissionMode ?? ""} empty={modes.find(({ id }) => id === catalog?.defaultMode)?.label ?? "Session default"} options={modes} onChange={(permissionMode) => change({ ...step, permissionMode: permissionMode || undefined })} />
              {problem && <div role="status" className="t-form-error">{problem}</div>}
            </li>;
          })}
        </ol>
        <button type="button" disabled={!first || steps.length >= 50} onClick={() => first && setSteps((old) => [...old, newStep(first)])}>Add step</button>
      </fieldset>}
      {error && <div role="alert" className="t-form-error">{error}</div>}
      <div className="t-fallback-actions">
        <Button label="Cancel" variant="secondary" isDisabled={busy} onClick={onClose} />
        <Button label="Save" variant="primary" isDisabled={!setup || busy || incomplete || (enabled && !steps.length)} onClick={() => void run(async () => {
          await rpc(runnerId, "setFallbackChain", { sessionId, enabled, steps, continueOnReset });
          onClose();
        })} />
      </div>
    </div>
  </Dialog>;
}
