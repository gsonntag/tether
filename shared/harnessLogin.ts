import type { AccountSource } from "./credentials";
import type { OpName } from "./protocol";
import type { HarnessId } from "./transcript";

export interface AccountIdentity {
  email?: string;
  plan?: string;
  organization?: string;
  accountId?: string;
  displayName?: string;
}

export interface HarnessAccount {
  source: AccountSource;
  status: HarnessLoginStatus;
  available: boolean;
  /** Live probe result for this account (G11). Absent on older runners. */
  probe?: "signedIn" | "signedOut" | "unknown";
  /** Set up with cswap (claude-swap): it signs in and removes the account, not Tether. */
  managedBy?: "cswap";
  /** Why it's unavailable, when Tether knows. */
  hint?: string;
}

export interface AccountDisplayLabel {
  name: string;
  detail?: string;
}

/** Compared without whitespace: auth status and the SDK space the same name differently. Self-contained for launcher script embedding. */
export function normalizedOrganization(name: string, email?: string): string {
  const normalized = name.replace(/[‘’]/g, "'").replace(/\s+/g, "");
  return email && normalized.toLowerCase() === `${email.toLowerCase()}'sorganization` ? normalized.toLowerCase() : normalized;
}

/**
 * Owner-facing label for a harness login (G9):
 * - name: displayName > email > organization > fallback
 * - detail: plan as given (omitting generic "Claude plan") and organization (omitted when name came from org or when it is the personal default "<email>'s Organization").
 */
export function accountDisplayLabel(status: HarnessLoginStatus | undefined, fallback: string): AccountDisplayLabel {
  if (!status || status.state !== "signedIn") return { name: fallback };
  const displayName = status.displayName?.trim() || "";
  const email = status.email?.trim() || "";
  const org = status.organization?.trim() || "";
  const plan = status.plan?.trim() || "";
  const nameFromOrg = !displayName && !email && !!org;
  const name = displayName || email || org || fallback;
  const planPart = plan && plan.toLowerCase() !== "claude plan" ? plan : "";
  const isPersonalDefaultOrg = !!org && !!email && normalizedOrganization(org, email) === normalizedOrganization(`${email}'s Organization`, email);
  const orgPart = org && !nameFromOrg && !isPersonalDefaultOrg ? org : "";
  const detail = [planPart, orgPart].filter(Boolean).join(" · ") || undefined;
  return detail ? { name, detail } : { name };
}

export type HarnessLoginStatus =
  | { state: "unavailable" | "unknown" | "signedOut" }
  | ({ state: "signedIn" } & AccountIdentity);

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
  "listHarnessAccounts", "removeHarnessAccount", "renameHarnessAccount", "harnessLoginCode", "harnessLoginCancel", "harnessLogout",
]);
