import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { bedrockTableRates } from "../../../shared/bedrockRates";
import type { BedrockModel, BedrockSettings } from "../../../shared/credentials";
import { rpc } from "../connection";
import { KeySlot, useCredentials } from "./Credentials";

const RATE_FIELDS = [
  ["input", "Input"], ["output", "Output"], ["cached", "Cache read"],
  ["cacheWrite", "Cache write"], ["cacheWriteLong", "Extended cache write"],
] as const;
type RateField = typeof RATE_FIELDS[number][0];
type Row = Pick<BedrockModel, "harness" | "alias" | "id"> & { rowId: number; rates: Partial<Record<RateField, string>> };
interface Form { region: string; auth: BedrockSettings["auth"]; profile: string; limit: string; rows: Row[] }
const blank: Form = { region: "", auth: "key", profile: "", limit: "", rows: [] };
let rowId = 0;

function formOf(settings: BedrockSettings | undefined): Form {
  if (!settings) return blank;
  return {
    region: settings.region, auth: settings.auth, profile: settings.profile ?? "",
    limit: settings.dailyLimitUsd?.toString() ?? "",
    rows: settings.models.map(({ rates, cacheWriteLong, ...model }) => ({
      ...model, rowId: ++rowId,
      rates: Object.fromEntries(Object.entries({ ...rates, cacheWriteLong }).map(([key, value]) => [key, value?.toString()])),
    })),
  };
}

function settingsOf(form: Form): BedrockSettings {
  const models = form.rows.map(({ rowId: _, rates, id, alias, harness }): BedrockModel => {
    const { input, output, cached, cacheWrite, cacheWriteLong } = rates;
    const override = Object.values(rates).some((value) => value?.trim());
    if (override && [input, output, cached].some((value) => !value?.trim())) throw new Error("Enter input, output and cache read rates for each override.");
    return {
      id: id.trim(), harness, ...(alias?.trim() ? { alias: alias.trim() } : {}),
      ...(override ? { rates: { input: Number(input), output: Number(output), cached: Number(cached), ...(cacheWrite?.trim() ? { cacheWrite: Number(cacheWrite) } : {}) } } : {}),
      ...(cacheWriteLong?.trim() ? { cacheWriteLong: Number(cacheWriteLong) } : {}),
    };
  });
  return { region: form.region.trim(), auth: form.auth, ...(form.auth === "profile" ? { profile: form.profile.trim() } : {}), models,
    ...(form.limit.trim() ? { dailyLimitUsd: Number(form.limit) } : {}) };
}

export function BedrockSettingsPage({ runnerId }: { runnerId: string }) {
  const { status, error, disabled, change } = useCredentials(runnerId);
  const slot = status?.bedrock;
  const [form, setForm] = useState<Form>(blank);
  const [problem, setProblem] = useState<string>();
  const [savedMessage, setSavedMessage] = useState(false);
  const saved = JSON.stringify(slot?.settings);
  useEffect(() => { setForm(formOf(slot?.settings)); }, [saved]);
  const edit = (patch: Partial<Form>) => {
    setForm((current) => ({ ...current, ...patch }));
    setSavedMessage(false);
    setProblem(undefined);
  };
  const editRow = (row: Row, patch: Partial<Row>) => edit({ rows: form.rows.map((item) => item.rowId === row.rowId ? { ...row, ...patch } : item) });
  const save = async () => {
    try { setSavedMessage(await change(rpc(runnerId, "setBedrock", settingsOf(form)))); }
    catch (error) { setProblem((error as Error).message); }
  };
  const submit = (e: React.FormEvent) => { e.preventDefault(); if (!disabled) void save(); };

  return <>
    {(problem || error) && <div className="t-inline-status error" role="alert">{problem || error}</div>}
    {!status ? !error && <div className="t-inline-status">Loading…</div> : !slot ? <div className="t-inline-status">Update the runner to configure Amazon Bedrock.</div> : <>
      <form className="t-azure" aria-label="Bedrock settings" autoComplete="off" onSubmit={submit}>
        <label className="t-field">AWS region<input required className="t-search" value={form.region} placeholder="us-east-1" disabled={disabled} onChange={(e) => edit({ region: e.target.value })} /></label>
        <label className="t-field">Authentication<select className="t-select" value={form.auth} disabled={disabled} onChange={(e) => edit({ auth: e.target.value as Form["auth"] })}>
          <option value="key">Bedrock API key</option><option value="profile">AWS profile on this runner</option>
        </select></label>
        {form.auth === "profile" && <label className="t-field">AWS profile<input required className="t-search" value={form.profile} disabled={disabled} onChange={(e) => edit({ profile: e.target.value })} /></label>}
        <label className="t-field">Daily spend guard (USD)<input className="t-search" type="number" min="0.000001" step="any" value={form.limit} placeholder="Off" disabled={disabled} onChange={(e) => edit({ limit: e.target.value })} /></label>
        {form.limit && <small>Stops new requests when the runner reaches the estimate or cannot price usage. Resets at midnight UTC.</small>}
        <Heading level={3}>Models</Heading>
        {form.rows.map((row, i) => {
          const table = bedrockTableRates(form.region.trim(), row);
          return <div key={row.rowId} className="t-azure-row" role="group" aria-label={row.id || `Model ${i + 1}`}>
            <label className="t-field">Harness<select className="t-select" value={row.harness} disabled={disabled} onChange={(e) => editRow(row, { harness: e.target.value as Row["harness"] })}>
              <option value="claude">Claude</option><option value="codex">Codex</option>
            </select></label>
            <label className="t-field">Model ID or inference profile<input required className="t-search" value={row.id} autoCapitalize="off" spellCheck={false} disabled={disabled} onChange={(e) => editRow(row, { id: e.target.value })} /></label>
            <label className="t-field">First-party model alias for switching<input className="t-search" value={row.alias ?? ""} placeholder="Optional" autoCapitalize="off" spellCheck={false} disabled={disabled} onChange={(e) => editRow(row, { alias: e.target.value })} /></label>
            <details className="t-credential-rates">
              <summary>{table ? "Rate override (USD per million tokens)" : "Rates (USD per million tokens)"}</summary>
              <div className="t-rate-fields">{RATE_FIELDS.map(([key, label]) =>
                <label className="t-field" key={key}>{key === "cacheWrite" ? `Cache write (${row.harness === "claude" ? "5 min" : "30 min"})` : key === "cacheWriteLong" ? `Cache write (${row.harness === "claude" ? "1 hr" : "12 hr"})` : label}<input className="t-search" type="number" step="any" min="0" max="1000000" inputMode="decimal"
                  value={row.rates[key] ?? ""} placeholder={table?.[key]?.toString() ?? "—"} disabled={disabled} onChange={(e) => editRow(row, { rates: { ...row.rates, [key]: e.target.value } })} /></label>)}</div>
            </details>
            <Button label="Remove model" variant="secondary" isDisabled={disabled} onClick={() => edit({ rows: form.rows.filter((item) => item.rowId !== row.rowId) })} />
          </div>;
        })}
        <div className="t-azure-foot">
          <Button label="Add model" variant="secondary" isDisabled={disabled || form.rows.length >= 50} onClick={() => edit({ rows: [...form.rows, { rowId: ++rowId, id: "", harness: "claude", rates: {} }] })} />
          <Button label="Save settings" variant="primary" type="submit" isDisabled={disabled} />
        </div>
        {savedMessage && <div className="t-inline-status" role="status">Settings saved.</div>}
      </form>
      {form.auth === "key" && <KeySlot source="bedrock" status={slot} disabled={disabled}
        save={(key) => void change(rpc(runnerId, "setCredential", { source: "bedrock", key }))}
        unset={() => void change(rpc(runnerId, "unsetCredential", { source: "bedrock" }))} />}
    </>}
  </>;
}
