// Checks on fallback profiles, shared by the settings UI (inline errors) and the runner (rejects the save).

import type { ModelProfile } from "./protocol";

/** Trims names and entries and drops blank entries. */
export const cleanProfiles = (profiles: ModelProfile[]): ModelProfile[] =>
  profiles.map((p) => ({ name: p.name.trim(), chain: p.chain.map((c) => c.trim()).filter(Boolean) }));

/** One message per profile: what is wrong with it, or undefined when it can be saved. */
export function profileProblems(profiles: ModelProfile[]): (string | undefined)[] {
  const clean = cleanProfiles(profiles);
  return clean.map((p, i) => {
    if (!p.name) return "Give the profile a name";
    if (clean.findIndex((x) => x.name === p.name) !== i) return `Another profile is already called “${p.name}”`;
    if (!p.chain.length) return "Add at least one model";
    return undefined;
  });
}
