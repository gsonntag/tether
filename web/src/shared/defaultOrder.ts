// The default order's entries: checks shared by Settings (inline errors) and the runner (refuses the save).

import { HARNESSES } from "./protocol";

/** Trims entries, drops blank ones and repeats. */
export const cleanOrder = (order: string[]): string[] => [...new Set(order.map((e) => e.trim()).filter(Boolean))];

/** What's wrong with an entry ("harness:model", the harness spelled out), or undefined. */
export function entryProblem(entry: string): string | undefined {
  const h = HARNESSES.find((x) => entry.startsWith(x.id + ":"));
  if (!h) return `“${entry}” doesn't start with a harness (${HARNESSES.map((x) => x.id).join(", ")})`;
  if (!entry.slice(h.id.length + 1).trim()) return `“${entry}” has no model`;
  // "#account" is reserved for the account or key an entry runs on (protocol.ts ChainEntry): not yet.
  if (entry.includes("#")) return `“${entry}” names an account, which isn't supported yet`;
  return undefined;
}
