// The Claude side query with a fake SDK: the prompt is withheld until the source is confirmed (and
// never sent when it isn't), a key goes through its lease with a budget and reports what it cost, and
// a timeout closes everything.

import { expect, test } from "bun:test";
import type { SessionCost } from "../../../../shared/costs";
import { ASK_BUDGET_USD, askWith, type AskDeps } from "./ask";

const PLAN = { apiProvider: "firstParty", apiKeySource: "none", tokenSource: "claude.ai", subscriptionType: "max" };
const KEY = { apiProvider: "firstParty", apiKeySource: "apiKeyHelper", tokenSource: "claude.ai" };

/** A fake query: reads the prompt stream, answers `answer` (or nothing, `hang`) once a prompt came. */
function fake(account: unknown, o: { answer?: string; cost?: number; hang?: boolean } = {}) {
  const seen = { options: undefined as any, prompts: [] as string[], closed: 0, leased: [] as unknown[], leaseClosed: 0 };
  const deps: AskDeps = {
    bin: "/fake/claude",
    lease: ((c: unknown) => (seen.leased.push(c), { helper: c ? "helper-cmd" : "", close: () => void seen.leaseClosed++ })) as never,
    query: (({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
      seen.options = options;
      let closed = false;
      const results: any[] = [];
      let wake: (() => void) | undefined;
      void (async () => {
        for await (const m of prompt) {
          seen.prompts.push(m.message.content);
          if (!o.hang) results.push({ type: "result", subtype: "success", is_error: false, result: o.answer ?? "Fix it", total_cost_usd: o.cost });
          wake?.();
        }
      })();
      return {
        initializationResult: async () => ({}),
        accountInfo: async () => account,
        close: () => {
          closed = true;
          seen.closed++;
          wake?.();
        },
        async *[Symbol.asyncIterator]() {
          while (!closed) {
            if (results.length) {
              yield results.shift();
              continue;
            }
            await new Promise<void>((r) => (wake = r));
          }
        },
      };
    }) as never,
  };
  return { deps, seen };
}

test("plan: answered after the source is confirmed; no budget, no lease, no MCP", async () => {
  const { deps, seen } = fake(PLAN, { answer: "Add tests" });
  const costs: SessionCost[] = [];
  expect(await askWith(deps, "/repo", "the diff", { system: "s", timeoutMs: 5000, onCost: (c) => costs.push(c) })).toBe("Add tests");
  expect(seen.prompts).toEqual(["the diff"]);
  expect(seen.options).toMatchObject({ model: "haiku", persistSession: false, tools: [], mcpServers: {}, strictMcpConfig: true, maxTurns: 1, settingSources: [] });
  expect(seen.options.maxBudgetUsd).toBeUndefined();
  expect(seen.options.settings.apiKeyHelper).toBe("");
  expect(costs).toEqual([]);
  expect(seen.closed).toBeGreaterThan(0);
  expect(seen.leaseClosed).toBe(1);
});

test("a source that isn't confirmed: the prompt never goes out", async () => {
  const key = { source: "anthropic", revision: "r", key: "sk-x", file: "/f" } as never;
  for (const [account, credential] of [[KEY, undefined], [PLAN, key], [undefined, undefined]] as const) {
    const { deps, seen } = fake(account);
    const costs: SessionCost[] = [];
    await expect(askWith(deps, "/repo", "secret diff", { credential, system: "s", timeoutMs: 5000, onCost: (c) => costs.push(c) })).rejects.toThrow("could not confirm");
    await Bun.sleep(5);
    expect(seen.prompts).toEqual([]);
    expect(costs).toEqual([]);
    expect(seen.leaseClosed).toBe(1);
  }
});

test("key: through the lease's helper, with a budget; what it cost is reported", async () => {
  const credential = { source: "anthropic", revision: "r", key: "sk-x", file: "/f" } as never;
  const { deps, seen } = fake(KEY, { answer: "Msg", cost: 0.0012 });
  const costs: SessionCost[] = [];
  expect(await askWith(deps, "/repo", "p", { credential, system: "s", timeoutMs: 5000, onCost: (c) => costs.push(c) })).toBe("Msg");
  expect(seen.leased).toEqual([credential]);
  expect(seen.options.settings.apiKeyHelper).toBe("helper-cmd");
  expect(seen.options.maxBudgetUsd).toBe(ASK_BUDGET_USD);
  expect(seen.options.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(costs).toEqual([{ usd: 0.0012, estimated: true, complete: true }]);
});

test("timeout: rejected in time, everything closed; a key's spend is marked unknown", async () => {
  const credential = { source: "anthropic", revision: "r", key: "sk-x", file: "/f" } as never;
  const { deps, seen } = fake(KEY, { hang: true });
  const costs: SessionCost[] = [];
  const t = Date.now();
  await expect(askWith(deps, "/repo", "p", { credential, system: "s", timeoutMs: 200, onCost: (c) => costs.push(c) })).rejects.toThrow("in time");
  expect(Date.now() - t).toBeLessThan(1000);
  expect(seen.prompts).toEqual(["p"]);
  expect(seen.closed).toBeGreaterThan(0);
  expect(seen.leaseClosed).toBe(1);
  expect(costs).toEqual([{ estimated: true, complete: false, reasons: ["no-usage"] }]);
});
