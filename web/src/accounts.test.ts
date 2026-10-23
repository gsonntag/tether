// The accounts slot's pure parts (credentials/accounts.tsx, shared/accounts.ts): account names and sign-in steps.

import { describe, expect, test } from "bun:test";
import { accountSlug } from "./shared/accounts";
import { accountSlots, nameProblem, signInGoesOn } from "./credentials/accounts";
import { slotFor } from "./credentials/slots";

describe("accounts slot", () => {
  test("names become id-safe slugs; the machine logins' names are refused", () => {
    expect(accountSlug("  Work Account ")).toBe("work-account");
    expect(accountSlug("gavin.personal")).toBe("gavin.personal");
    expect(nameProblem("")).toBeUndefined();
    expect(nameProblem("work")).toBeUndefined();
    expect(nameProblem("Machine")).toMatch(/machine's own login/);
    expect(nameProblem("!!!")).toMatch(/Letters/);
  });

  test("a sign-in goes on while its answer carries the credential; a slot per provider owns its sign-in actions", async () => {
    expect(signInGoesOn({ id: "claude:a", url: "https://claude.ai/oauth/authorize", next: { action: "signInCode", prompt: "Paste the code" } })).toBe(true);
    expect(signInGoesOn({ message: "Signed in." })).toBe(false);
    expect(signInGoesOn(undefined)).toBe(false);
    await import("./credentials");
    expect(accountSlots.map((s) => s.provider)).toEqual(["claude", "chatgpt", "kiro", "antigravity"]);
    expect(slotFor("claude")?.ownActions).toContain("signIn");
    expect(slotFor("chatgpt")?.Add).toBeDefined();
  });
});
