// Account labels from the owner-only account listing: pure, so tests reach them without a connection.
import type { HarnessAccount, HarnessLoginStatus } from "../../shared/harnessLogin";

export const labelOf = (status: HarnessLoginStatus) => status.state === "signedIn"
  ? [status.displayName || status.organization || status.email, status.plan].filter(Boolean).join(" · ")
  : "";

/** A personal account's organization is only "<email>'s Organization". */
const personalOrg = (email: string, organization?: string) =>
  !organization || organization.replace(/[‘’]/g, "'").replace(/\s+/g, "").toLowerCase() === `${email.toLowerCase()}'sorganization`;

/** A cswap account: by email, with its organization when it isn't the personal one. */
export function cswapLabel(status: HarnessLoginStatus) {
  if (status.state !== "signedIn") return "";
  const name = status.displayName || [status.email, status.email && !personalOrg(status.email, status.organization) ? status.organization : undefined].filter(Boolean).join(" · ");
  return [name, status.plan, "via cswap"].filter(Boolean).join(" · ");
}

export const accountLabelOf = (account: HarnessAccount) => account.managedBy === "cswap" ? cswapLabel(account.status) : labelOf(account.status);
