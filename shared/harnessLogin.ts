import type { OpName } from "./protocol";
import type { HarnessId } from "./transcript";

export type HarnessLoginStatus =
  | { state: "unavailable" | "unknown" | "signedOut" }
  | { state: "signedIn"; email?: string; plan?: string; organization?: string; accountId?: string; displayName?: string };

export type HarnessLoginFlow =
  | { state: "pending"; url?: string; deviceCode?: string; acceptsCode?: boolean }
  | { state: "done" | "failed" | "expired" | "cancelled" };

/** Authentication failures from the harness itself, as shown in the transcript and inbox. */
export function needsHarnessLogin(text: string): boolean {
  return /\b(?:authentication required|not logged in|not signed in|isn't signed in|could not confirm the Claude subscription|refresh token (?:has )?(?:expired|already been used)|(?:access |oauth )?token (?:has )?(?:expired|been revoked)|(?:sign|log) in again)\b/i.test(text);
}

export const harnessLoginHref = (runnerId: string, harness: HarnessId) =>
  `#/settings/credentials/${encodeURIComponent(runnerId)}/${harness}`;

export const HARNESS_LOGIN_OPS: ReadonlySet<OpName> = new Set<OpName>([
  "harnessLoginStatus", "harnessLoginStart", "harnessLoginPoll",
  "renameHarnessAccount", "harnessLoginCode", "harnessLoginCancel", "harnessLogout",
]);
