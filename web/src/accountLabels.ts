// Account labels from the owner-only account listing: pure, so tests reach them without a connection.
import { isAccountSource, type BillingSource } from "../../shared/credentials";
import { accountDisplayLabel, normalizedOrganization, type HarnessAccount, type HarnessLoginStatus } from "../../shared/harnessLogin";

export interface AccountLabelEntry {
  name: string;
  detail?: string;
  /** Joined display string (`name · detail`), empty when unsigned. */
  label: string;
  probe?: HarnessAccount["probe"];
  available?: boolean;
  managedBy?: HarnessAccount["managedBy"];
  hint?: string;
}

export const labelOf = (status: HarnessLoginStatus): string => {
  if (status.state !== "signedIn") return "";
  const { name, detail } = accountDisplayLabel(status, "");
  return [name, detail].filter(Boolean).join(" · ");
};

/** A personal account's organization is only "<email>'s Organization". */
const personalOrg = (email: string, organization?: string) =>
  !organization || normalizedOrganization(organization, email) === normalizedOrganization(`${email}'s Organization`, email);

/** A cswap account: by email, with its organization when it isn't the personal one. */
export function cswapLabel(status: HarnessLoginStatus): string {
  if (status.state !== "signedIn") return "";
  const name = status.displayName || [status.email, status.email && !personalOrg(status.email, status.organization) ? status.organization : undefined].filter(Boolean).join(" · ");
  const plan = status.plan && status.plan.toLowerCase() !== "claude plan" ? status.plan : undefined;
  return [name, plan, "via cswap"].filter(Boolean).join(" · ");
}

export const accountLabelOf = (account: HarnessAccount): string =>
  account.managedBy === "cswap" ? cswapLabel(account.status) : labelOf(account.status);

export interface AccountLabelInput {
  source: BillingSource;
  status?: HarnessLoginStatus;
  available?: boolean;
  probe?: HarnessAccount["probe"];
  managedBy?: HarnessAccount["managedBy"];
  hint?: string;
}

/**
 * Builds structured account labels with a list-level collision pass (G9):
 * when two signed-in entries share the same primary name, disambiguate with email local part
 * (or full email if local parts collide, else short source id).
 */
export function resolveAccountLabels(items: readonly AccountLabelInput[]): {
  labels: Partial<Record<BillingSource, string>>;
  entries: Partial<Record<BillingSource, AccountLabelEntry>>;
  probes: Partial<Record<BillingSource, HarnessAccount["probe"]>>;
} {
  type Draft = {
    item: AccountLabelInput;
    name: string;
    detail?: string;
    email?: string;
  };
  const drafts: Draft[] = items.map((item) => {
    const status = item.status;
    if (!status || status.state !== "signedIn") {
      return { item, name: "" };
    }
    const base = accountDisplayLabel(status, "");
    const extraDetail = item.managedBy === "cswap"
      ? [base.detail, "via cswap"].filter(Boolean).join(" · ")
      : base.detail;
    return {
      item,
      name: base.name,
      ...(extraDetail ? { detail: extraDetail } : {}),
      ...(status.email ? { email: status.email.trim() } : {}),
    };
  });

  // Group signed-in drafts by case-insensitive name to detect collisions.
  const groups = new Map<string, Draft[]>();
  for (const d of drafts) {
    if (!d.name) continue;
    const key = d.name.toLowerCase();
    const list = groups.get(key) ?? [];
    list.push(d);
    groups.set(key, list);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const localOf = (email?: string) => {
      const at = email?.indexOf("@") ?? -1;
      return at > 0 ? email!.slice(0, at) : "";
    };
    const locals = group.map((d) => localOf(d.email).toLowerCase());
    const emails = group.map((d) => (d.email ?? "").toLowerCase());
    const shortOf = (source: BillingSource) => (isAccountSource(source) ? source.slice(8, 16) : source === "subscription" ? "primary" : source);
    for (let i = 0; i < group.length; i++) {
      const d = group[i]!;
      const local = localOf(d.email);
      const localUnique = !!local && local.toLowerCase() !== d.name.toLowerCase() && locals.filter((x) => x === local.toLowerCase()).length === 1;
      const emailUnique = !!d.email && d.email.toLowerCase() !== d.name.toLowerCase() && emails.filter((x) => x === d.email!.toLowerCase()).length === 1;
      const tag = localUnique ? local : emailUnique ? d.email! : shortOf(d.item.source);
      d.name = `${d.name} (${tag})`;
    }
  }

  const labels: Partial<Record<BillingSource, string>> = {};
  const entries: Partial<Record<BillingSource, AccountLabelEntry>> = {};
  const probes: Partial<Record<BillingSource, HarnessAccount["probe"]>> = {};
  for (const d of drafts) {
    const label = [d.name, d.detail].filter(Boolean).join(" · ");
    labels[d.item.source] = label;
    entries[d.item.source] = {
      name: d.name,
      ...(d.detail ? { detail: d.detail } : {}),
      label,
      ...(d.item.probe ? { probe: d.item.probe } : {}),
      ...(d.item.available !== undefined ? { available: d.item.available } : {}),
      ...(d.item.managedBy ? { managedBy: d.item.managedBy } : {}),
      ...(d.item.hint ? { hint: d.item.hint } : {}),
    };
    if (d.item.probe) probes[d.item.source] = d.item.probe;
  }
  return { labels, entries, probes };
}
