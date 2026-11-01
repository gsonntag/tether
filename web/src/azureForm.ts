// The Azure page's deployment rows: text while they're edited, checked into deployments to save.
import type { AzureDeployment, CredentialSlot } from "../../shared/credentials";
import { azureResource } from "../../shared/credentials";
import { azureTableRates, type AzureType, type AzureTypeRates } from "../../shared/azureRates";

export interface Row { id: string; name: string; model: string; type: AzureType; override: boolean; input: string; cached: string; cacheWrite: string; output: string }
let next = 0;
export const blankRow = (): Row => ({ id: `row-${++next}`, name: "", model: "", type: "global", override: false, input: "", cached: "", cacheWrite: "", output: "" });
const text = (n?: number) => (n === undefined ? "" : String(n));
/** Saved rates are the row's Override; a row from before types is Global. */
export const rowsOf = (slot?: CredentialSlot): Row[] => (slot?.deployments ?? []).map((d) => ({
  ...blankRow(), name: d.name, model: d.model ?? "", type: d.type ?? "global", override: !!d.rates,
  input: text(d.rates?.input), cached: text(d.rates?.cached), cacheWrite: text(d.rates?.cacheWrite), output: text(d.rates?.output),
}));
/** What the Resource field shows: the name it was made from, else the endpoint. */
export const resourceOf = (slot?: CredentialSlot) => azureResource(slot?.endpoint) ?? slot?.endpoint ?? "";
/** The table's rates for the row's model and type, if it has them. */
export const tableOf = (row: Row): AzureTypeRates | undefined => azureTableRates(row.model, row.type);
/** Whether the row's own fields price it: Override is on, or the table has nothing for it. */
export const manual = (row: Row) => row.override || !tableOf(row);

const rate = (v: string) => (v.trim() === "" ? undefined : Number(v));
/** The rows as deployments, or what's wrong with them, in a few words. Blank rows are dropped. */
export function deploymentsOf(rows: Row[]): { deployments: AzureDeployment[] } | { error: string } {
  const deployments: AzureDeployment[] = [];
  for (const r of rows) {
    const name = r.name.trim();
    const values = [rate(r.input), rate(r.cached), rate(r.output)];
    const write = rate(r.cacheWrite);
    if (!name && !r.model.trim() && values.every((v) => v === undefined) && write === undefined) continue;
    if (!name) return { error: "Each deployment needs a name." };
    if (deployments.some((d) => d.name === name)) return { error: `${name} is listed twice.` };
    const base: AzureDeployment = { name, ...(r.model.trim() ? { model: r.model.trim() } : {}), type: r.type };
    if (!manual(r)) { deployments.push(base); continue; }
    if (values.some((v) => v === undefined) && (values.some((v) => v !== undefined) || write !== undefined)) return { error: `${name}: enter input, cached and output, or none.` };
    if ([...values, write].some((v) => v !== undefined && (!Number.isFinite(v) || v < 0))) return { error: `${name}: rates are USD per 1M tokens.` };
    const [input, cached, output] = values as (number | undefined)[];
    if (input === undefined && r.override && tableOf(r)) return { error: `${name}: enter the override rates.` };
    deployments.push({ ...base, ...(input !== undefined ? { rates: { input, cached: cached!, output: output!, ...(write !== undefined ? { cacheWrite: write } : {}) } } : {}) });
  }
  return { deployments };
}

/** Whether the form says the same as what's saved. */
export function unchanged(slot: CredentialSlot | undefined, resource: string, rows: Row[]): boolean {
  const now = deploymentsOf(rows);
  const saved = deploymentsOf(rowsOf(slot));
  return resource.trim() === resourceOf(slot) && "deployments" in now && JSON.stringify(now) === JSON.stringify(saved);
}
