// The Azure page's deployment rows: text while they're edited, checked into deployments to save.
import type { AzureDeployment, CredentialSlot } from "../../shared/credentials";
import { azureResource } from "../../shared/credentials";

export interface Row { id: string; name: string; model: string; input: string; cached: string; output: string }
let next = 0;
export const blankRow = (): Row => ({ id: `row-${++next}`, name: "", model: "", input: "", cached: "", output: "" });
const text = (n?: number) => (n === undefined ? "" : String(n));
export const rowsOf = (slot?: CredentialSlot): Row[] => (slot?.deployments ?? []).map((d) => ({ ...blankRow(), name: d.name, model: d.model ?? "", input: text(d.rates?.input), cached: text(d.rates?.cached), output: text(d.rates?.output) }));
/** What the Resource field shows: the name it was made from, else the endpoint. */
export const resourceOf = (slot?: CredentialSlot) => azureResource(slot?.endpoint) ?? slot?.endpoint ?? "";

const rate = (v: string) => (v.trim() === "" ? undefined : Number(v));
/** The rows as deployments, or what's wrong with them, in a few words. Blank rows are dropped. */
export function deploymentsOf(rows: Row[]): { deployments: AzureDeployment[] } | { error: string } {
  const deployments: AzureDeployment[] = [];
  for (const r of rows) {
    const name = r.name.trim();
    const values = [rate(r.input), rate(r.cached), rate(r.output)];
    if (!name && !r.model.trim() && values.every((v) => v === undefined)) continue;
    if (!name) return { error: "Each deployment needs a name." };
    if (deployments.some((d) => d.name === name)) return { error: `${name} is listed twice.` };
    if (values.some((v) => v === undefined) && values.some((v) => v !== undefined)) return { error: `${name}: enter all three rates, or none.` };
    if (values.some((v) => v !== undefined && (!Number.isFinite(v) || v < 0))) return { error: `${name}: rates are USD per 1M tokens.` };
    const [input, cached, output] = values as (number | undefined)[];
    deployments.push({ name, ...(r.model.trim() ? { model: r.model.trim() } : {}), ...(input !== undefined ? { rates: { input, cached: cached!, output: output! } } : {}) });
  }
  return { deployments };
}

/** Whether the form says the same as what's saved. */
export function unchanged(slot: CredentialSlot | undefined, resource: string, rows: Row[]): boolean {
  const now = deploymentsOf(rows);
  const saved = deploymentsOf(rowsOf(slot));
  return resource.trim() === resourceOf(slot) && "deployments" in now && JSON.stringify(now) === JSON.stringify(saved);
}
