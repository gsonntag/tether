import { expect, test } from "bun:test";
import type { AccountSource } from "../../shared/credentials";
import { accountLabelOf, cswapLabel, resolveAccountLabels } from "./accountLabels";

test("a cswap account is labeled by email, its organization only when it isn't the personal one", () => {
  const source: AccountSource = "account:b8d64ec2-b923-4e94-811e-3f6fe0235a0f";
  expect(cswapLabel({ state: "signedIn", email: "a@example.test", organization: "a@example.test's Organization", plan: "pro" })).toBe("a@example.test · pro · via cswap");
  expect(cswapLabel({ state: "signedIn", email: "a@example.test", organization: "Acme Team" })).toBe("a@example.test · Acme Team · via cswap");
  expect(cswapLabel({ state: "signedIn", email: "a@example.test", organization: "Acme Team", displayName: "Work" })).toBe("Work · via cswap");
  expect(accountLabelOf({ source, available: true, status: { state: "signedIn", email: "a@example.test", organization: "Acme Team" } })).toBe("a@example.test · Acme Team");
  expect(accountLabelOf({ source, available: false, managedBy: "cswap", status: { state: "signedIn", email: "a@example.test" } })).toBe("a@example.test · via cswap");
});

test("list-level collision pass disambiguates duplicate names by email local part, full email, or short id (G9, G11')", () => {
  const acc1: AccountSource = "account:11111111-1111-4111-8111-111111111111";
  const acc2: AccountSource = "account:22222222-2222-4222-8222-222222222222";
  const acc3: AccountSource = "account:33333333-3333-4333-8333-333333333333";

  // Same displayName, distinct email local parts -> local part.
  const byLocal = resolveAccountLabels([
    { source: "subscription", status: { state: "signedIn", displayName: "Work", email: "alice@co.test", plan: "Max" } },
    { source: acc1, status: { state: "signedIn", displayName: "Work", email: "bob@co.test", plan: "Pro" }, probe: "signedIn" },
  ]);
  expect(byLocal.entries.subscription?.name).toBe("Work (alice)");
  expect(byLocal.entries[acc1]?.name).toBe("Work (bob)");
  expect(byLocal.labels[acc1]).toBe("Work (bob) · Pro");
  expect(byLocal.probes[acc1]).toBe("signedIn");

  // Same displayName and same email local part -> full email.
  const byEmail = resolveAccountLabels([
    { source: acc1, status: { state: "signedIn", displayName: "Team", email: "alex@alpha.test" } },
    { source: acc2, status: { state: "signedIn", displayName: "Team", email: "alex@beta.test" } },
  ]);
  expect(byEmail.entries[acc1]?.name).toBe("Team (alex@alpha.test)");
  expect(byEmail.entries[acc2]?.name).toBe("Team (alex@beta.test)");

  // Same displayName and same email -> short source id.
  const byId = resolveAccountLabels([
    { source: "subscription", status: { state: "signedIn", displayName: "Shared", email: "same@co.test" } },
    { source: acc3, status: { state: "signedIn", displayName: "Shared", email: "same@co.test" } },
  ]);
  expect(byId.entries.subscription?.name).toBe("Shared (primary)");
  expect(byId.entries[acc3]?.name).toBe("Shared (33333333)");
});
