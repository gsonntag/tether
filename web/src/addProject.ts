// The Add project dialog's pure parts.

export const ADD_MODES = ["folder", "new", "clone"] as const;
export type AddMode = (typeof ADD_MODES)[number];

/** The mode remembered on this device, if it's still one of them. */
export const addModeOf = (stored: string | null): AddMode => (ADD_MODES.includes(stored as AddMode) ? (stored as AddMode) : "folder");

/** listDirs / addProject failed because the folder isn't there (an older runner passes node's ENOENT through), not for any other reason. */
export const isMissing = (err: string) => /doesn't exist|\bENOENT\b/.test(err);

/** The runner predates the op (runner/src/index.ts handle()). */
export const isOldRunner = (err: string) => /^This runner doesn't know /.test(err);

/** Up to `max` repos whose org/name has every word of the filter. */
export function filterRepos<R extends { nameWithOwner: string }>(repos: R[], filter: string, max = 50): R[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  return repos.filter((r) => words.every((w) => r.nameWithOwner.toLowerCase().includes(w))).slice(0, max);
}
