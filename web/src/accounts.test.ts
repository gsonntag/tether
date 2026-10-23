// The accounts slot's pure parts (credentials/accounts.tsx, shared/accounts.ts): account names and flow states.

import { describe, expect, test } from "bun:test";
import { accountSlug } from "./shared/accounts";
import { accountSlots, flowLive, nameProblem } from "./credentials/accounts";
import { slotFor } from "./credentials";

describe("accounts slot", () => {
  test("names become id-safe slugs; the machine logins' names are refused", () => {
    expect(accountSlug("  Work Account ")).toBe("work-account");
    expect(accountSlug("gavin.personal")).toBe("gavin.personal");
    expect(nameProblem("")).toBeUndefined();
    expect(nameProblem("work")).toBeUndefined();
    expect(nameProblem("Machine")).toMatch(/machine's own login/);
    expect(nameProblem("!!!")).toMatch(/Letters/);
  });

  test("live flows, and a slot per provider that owns its sign-in actions", () => {
    expect(
      flowLive({
        id: "claude:a",
        kind: "paste",
        state: "waiting",
        startedAt: 0,
      }),
    ).toBe(true);
    expect(flowLive({ id: "claude:a", kind: "paste", state: "done", startedAt: 0 })).toBe(false);
    expect(accountSlots.map((s) => s.provider)).toEqual(["claude", "chatgpt", "kiro", "antigravity"]);
    expect(slotFor("claude")?.ownActions).toContain("signIn");
    expect(slotFor("chatgpt")?.Add).toBeDefined();
  });
});
