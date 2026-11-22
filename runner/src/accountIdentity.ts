import { createHash } from "node:crypto";
import type { AccountIdentity } from "../../shared/harnessLogin";

export function accountIdentity(email: unknown, plan: unknown, organization: unknown = undefined, orgId: unknown = undefined): AccountIdentity {
  const address = typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : undefined;
  const org = typeof organization === "string" && organization.length <= 200 && !/[\u0000-\u001f\u007f]/.test(organization) ? organization.trim() || undefined : undefined;
  const scope = typeof orgId === "string" && orgId.length <= 128 ? orgId : org;
  const accountId = address || scope
    ? createHash("sha256").update(JSON.stringify([address?.toLowerCase(), scope])).digest("hex")
    : undefined;
  return {
    ...(address ? { email: address } : {}),
    ...(org ? { organization: org } : {}),
    ...(accountId ? { accountId } : {}),
    ...(typeof plan === "string" && /^[\w .+-]{1,60}$/.test(plan) ? { plan } : {}),
  };
}
