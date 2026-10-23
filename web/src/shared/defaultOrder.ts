// The default order's entries: checks shared by Settings (inline errors) and the runner (refuses the save).

import { isCredentialId } from "./credentials";
import { HARNESSES } from "./protocol";

/** Trims entries, drops blank ones and repeats. */
export const cleanOrder = (order: string[]): string[] => [...new Set(order.map((e) => e.trim()).filter(Boolean))];

/**
 * What's wrong with an entry ("harness:model", the harness spelled out, optionally "#credential"),
 * or undefined. `credentials`: the ids this runner has; without it a credential is only checked
 * for its shape.
 */
export function entryProblem(entry: string, credentials?: ReadonlySet<string>): string | undefined {
  const h = HARNESSES.find((x) => entry.startsWith(x.id + ":"));
  if (!h) return `“${entry}” doesn't start with a harness (${HARNESSES.map((x) => x.id).join(", ")})`;
  const hash = entry.indexOf("#");
  const model = (hash >= 0 ? entry.slice(h.id.length + 1, hash) : entry.slice(h.id.length + 1)).trim();
  if (!model) return `“${entry}” has no model`;
  if (hash < 0) return undefined;
  const cred = entry.slice(hash + 1);
  if (!isCredentialId(cred)) return `“${entry}” names an account or key that isn't one (“${cred}”)`;
  if (credentials && !credentials.has(cred)) return `“${entry}” runs on ${cred}, which isn't on this runner`;
  return undefined;
}
