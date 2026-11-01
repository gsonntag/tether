import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { rpc } from "../connection";
import { blankRow, deploymentsOf, manual, resourceOf, rowsOf, tableOf, unchanged, type Row } from "../azureForm";
import { AZURE_RATES_DATE, AZURE_RATES_SOURCE, type AzureBand, type AzureType } from "../../../shared/azureRates";
import { loadModels, modelListKey, useStore } from "../store";
import { KeySlot, useCredentials } from "./Credentials";

const RATES = [["input", "Input"], ["cached", "Cached"], ["cacheWrite", "Cache write"], ["output", "Output"]] as const;
const TYPES: [AzureType, string][] = [["global", "Global"], ["dataZone", "Data Zone"], ["regional", "Regional"]];
const TABLE_NOTE = `${AZURE_RATES_SOURCE}, ${AZURE_RATES_DATE}`;
const cell = (n?: number) => (n === undefined ? "—" : String(n));

/** The table's rates for a row, read-only: short context, and long where listed. */
function TableRates({ short, long }: { short: AzureBand; long?: AzureBand }) {
  const line = (label: string, b?: AzureBand) => <tr><th scope="row">{label}</th>{RATES.map(([k]) => <td key={k}>{b ? cell(b[k]) : "—"}</td>)}</tr>;
  return (
    <table className="t-azure-table" title={TABLE_NOTE} aria-label="Table rates, USD / 1M tokens">
      <thead><tr><th scope="col">USD/1M</th>{RATES.map(([k, label]) => <th scope="col" key={k}>{k === "cacheWrite" ? "Write" : label}</th>)}</tr></thead>
      <tbody>{line("≤272K", short)}{line(">272K", long)}</tbody>
    </table>
  );
}

/** Azure for Codex: its key, the resource requests go to, and the deployments sessions can run on. */
export function AzureSettings({ runnerId }: { runnerId: string }) {
  const { status, error, disabled, change } = useCredentials(runnerId);
  const azure = status?.azure;
  const models = useStore((s) => s.modelLists[modelListKey(runnerId, "codex")]);
  const [resource, setResource] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [problem, setProblem] = useState<string>();
  const [tests, setTests] = useState<Record<string, { ok?: boolean; text: string }>>({});
  // What's saved, as the form last took it: a key saved meanwhile doesn't undo what's being typed.
  const saved = JSON.stringify([azure?.endpoint, azure?.deployments]);
  useEffect(() => {
    if (!azure) return;
    setResource(resourceOf(azure));
    setRows(rowsOf(azure));
    setProblem(undefined);
  }, [saved, !!azure]);
  useEffect(() => { if (!models) void loadModels(runnerId, "codex"); }, [runnerId]);

  const dirty = !!azure && !unchanged(azure, resource, rows);
  const edit = (id: string, patch: Partial<Row>) => setRows((list) => list.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const save = async () => {
    const checked = deploymentsOf(rows);
    if ("error" in checked) return setProblem(checked.error);
    setProblem(undefined);
    await change(rpc(runnerId, "setAzure", { endpoint: resource.trim(), deployments: checked.deployments }));
  };
  const test = async (row: Row) => {
    setTests((t) => ({ ...t, [row.id]: { text: "Testing…" } }));
    const r = await rpc(runnerId, "testAzure", { deployment: row.name.trim() }).catch((e) => ({ ok: false, text: (e as Error)?.message || "Couldn't test" }));
    setTests((t) => ({ ...t, [row.id]: r }));
  };
  const known = (models?.models ?? []).filter((m) => m.id !== "default");

  return <>
    {error && <div className="t-inline-status error" role="alert">{error}</div>}
    {!status || !azure ? !error && <div className="t-inline-status">Loading…</div> : <>
      <KeySlot source="azure" status={azure} disabled={disabled} save={(key) => void change(rpc(runnerId, "setCredential", { source: "azure", key }))} unset={() => void change(rpc(runnerId, "unsetCredential", { source: "azure" }))} />
      <form className="t-azure" aria-label="Azure settings" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (!disabled && dirty) void save(); }}>
        <label className="t-field">Resource<input className="t-search" value={resource} placeholder="Resource name or https://…" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={disabled} onChange={(e) => setResource(e.target.value)} /></label>
        {azure.endpoint && resource.trim() === resourceOf(azure) && resource.trim() !== azure.endpoint && <div className="t-azure-endpoint">{azure.endpoint}</div>}
        <Heading level={3}>Deployments</Heading>
        {rows.map((row, n) => {
          const result = tests[row.id];
          const table = tableOf(row);
          const own = manual(row);
          const rated = RATES.filter(([k]) => row[k].trim() !== "");
          const whole = [row.input, row.cached, row.output].every((v) => v.trim() !== "");
          const fields = (
            <div className="t-rate-fields">
              {RATES.map(([k, label]) => <label className="t-field" key={k}>{label}<input className="t-search" type="number" min="0" max="1000000" step="any" inputMode="decimal" value={row[k]} placeholder={k === "cacheWrite" || !table ? "Optional" : undefined} disabled={disabled} onChange={(e) => edit(row.id, { [k]: e.target.value, override: true })} /></label>)}
            </div>
          );
          return (
            <div className="t-azure-row" role="group" aria-label={`Deployment ${row.name.trim() || n + 1}`} key={row.id}>
              <div className="t-azure-names">
                <label className="t-field">Deployment<input className="t-search" value={row.name} autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={disabled} onChange={(e) => edit(row.id, { name: e.target.value })} /></label>
                <label className="t-field">Model<input className="t-search" list="t-azure-models" value={row.model} placeholder="Optional" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={disabled} onChange={(e) => edit(row.id, { model: e.target.value })} /></label>
                <label className="t-field">Type<select className="t-select" aria-label="Type" value={row.type} disabled={disabled} onChange={(e) => edit(row.id, { type: e.target.value as AzureType })}>{TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>
              </div>
              {table && <label className="t-check t-azure-override"><input type="checkbox" checked={row.override} disabled={disabled} onChange={(e) => edit(row.id, { override: e.target.checked })} /><span>Override</span></label>}
              {table && !own ? <TableRates short={table.short} long={table.long} /> : table ? fields : (
                <details className="t-credential-rates" open={rated.length > 0 && !whole ? true : undefined}>
                  <summary>{whole ? `USD / 1M · ${RATES.map(([k]) => row[k].trim() || "—").join(" · ")}` : "USD / 1M tokens"}</summary>
                  {fields}
                </details>
              )}
              <div className="t-azure-actions">
                <Button label="Test" variant="secondary" isDisabled={disabled || dirty || !azure.set || !row.name.trim() || result?.text === "Testing…"} onClick={() => void test(row)} />
                {result && <span className={`t-azure-result${result.ok === true ? " ok" : result.ok === false ? " fail" : ""}`} role="status">{result.text}</span>}
                <Button label="Remove" variant="secondary" isDisabled={disabled} onClick={() => setRows((list) => list.filter((r) => r.id !== row.id))} />
              </div>
            </div>
          );
        })}
        <div className="t-azure-foot">
          <Button label="Add deployment" variant="secondary" isDisabled={disabled} onClick={() => setRows((list) => [...list, blankRow()])} />
          <Button label="Save" variant="primary" type="submit" isDisabled={disabled || !dirty} />
        </div>
        {problem && <div className="t-form-error" role="alert">{problem}</div>}
        <datalist id="t-azure-models">{known.map((m) => <option key={m.id} value={m.id} />)}</datalist>
      </form>
    </>}
  </>;
}
