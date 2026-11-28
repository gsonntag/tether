(globalThis as any).location ??= { protocol: "http:", host: "localhost" };
(globalThis as any).document ??= { addEventListener() {}, visibilityState: "visible" };
(globalThis as any).window ??= { addEventListener() {} };
(globalThis as any).requestAnimationFrame ??= () => 0;

import { afterEach, expect, test } from "bun:test";
import type { AccountSource } from "../../shared/credentials";
import { CURRENT_SOURCE, sourceMenu } from "./sourceMenu";

const { clearAccountLabelCache, loadAccountLabels } = await import("./accountLabel");

afterEach(() => {
  clearAccountLabelCache();
});

test("useAccountLabel cache deduplicates concurrent probes for the same (runner, harness) (G8, G11')", async () => {
  const calls: { op: string; harness: string }[] = [];
  let releaseStatus!: () => void;
  const fakeRpc: any = async (_runnerId: string, op: string, args: any) => {
    calls.push({ op, harness: args.harness });
    if (op === "harnessLoginStatus") {
      await new Promise<void>((r) => (releaseStatus = r));
      return { state: "signedIn", email: "main@co.test", plan: "Max" };
    }
    if (op === "listHarnessAccounts") {
      return [
        {
          source: "account:3f2a9c1e-1111-4222-8333-444444444444",
          available: true,
          probe: "signedIn",
          status: { state: "signedIn", displayName: "Work", email: "work@co.test", plan: "Pro" },
        },
      ];
    }
    return null;
  };
  const p1 = loadAccountLabels("r1", "claude", false, fakeRpc);
  const p2 = loadAccountLabels("r1", "claude", false, fakeRpc);
  expect(p1).toBe(p2);
  releaseStatus();
  await Promise.all([p1, p2]);
  expect(calls).toEqual([
    { op: "harnessLoginStatus", harness: "claude" },
    { op: "listHarnessAccounts", harness: "claude" },
  ]);
});

test("sourceMenu applies owner accountLabels to options and CURRENT_SOURCE (G8)", () => {
  const acc: AccountSource = "account:3f2a9c1e-1111-4222-8333-444444444444";
  const menu = sourceMenu(
    "claude",
    {
      mode: "live",
      status: "idle",
      requests: [],
      queue: [],
      billing: { kind: "plan", label: "Claude plan · 3f2a9c1e", source: acc },
    },
    { options: [{ source: "subscription", billing: { kind: "plan", label: "Claude plan" } }] },
    { subscription: "Personal · Max", [acc]: "Work · Pro" },
  );
  expect(menu.value).toBe(CURRENT_SOURCE);
  expect(menu.items).toEqual([
    { value: CURRENT_SOURCE, label: "Work · Pro" },
    { value: "subscription", label: "Personal · Max" },
  ]);
});
