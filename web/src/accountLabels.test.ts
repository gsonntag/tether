import { expect, test } from "bun:test";
import { accountLabelOf, cswapLabel } from "./accountLabels";

test("a cswap account is labeled by email, its organization only when it isn't the personal one", () => {
  const source = "account:b8d64ec2-b923-4e94-811e-3f6fe0235a0f" as const;
  expect(cswapLabel({ state: "signedIn", email: "a@example.test", organization: "a@example.test's Organization", plan: "pro" })).toBe("a@example.test · pro · via cswap");
  expect(cswapLabel({ state: "signedIn", email: "a@example.test", organization: "Acme Team" })).toBe("a@example.test · Acme Team · via cswap");
  expect(cswapLabel({ state: "signedIn", email: "a@example.test", organization: "Acme Team", displayName: "Work" })).toBe("Work · via cswap");
  expect(accountLabelOf({ source, available: true, status: { state: "signedIn", email: "a@example.test", organization: "Acme Team" } })).toBe("Acme Team");
  expect(accountLabelOf({ source, available: false, managedBy: "cswap", status: { state: "signedIn", email: "a@example.test" } })).toBe("a@example.test · via cswap");
});
