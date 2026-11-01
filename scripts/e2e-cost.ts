// The real private host (runner/src/adapters/codex/privateHost.ts) as the OpenAI source, in front of
// scripts/fake-responses.ts, with each response shape the docs leave open. Priced from what a real
// Codex request looks like: no service_tier and no prompt_cache_options. No model, no key, no Codex:
// a stand-in takes Codex's place, because only the host's bytes and its costs.json are under test.
//   NODE_TLS_REJECT_UNAUTHORIZED=0 bun scripts/e2e-cost.ts <dir> <port>
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CostLedger } from "../runner/src/costs";
import { costChip } from "../shared/costs";

const [parent, port] = process.argv.slice(2);
if (!parent || !port || !process.env.NODE_TLS_REJECT_UNAUTHORIZED) throw new Error("usage: NODE_TLS_REJECT_UNAUTHORIZED=0 bun scripts/e2e-cost.ts <dir> <port>");
const dir = mkdtempSync(join(resolve(parent), "run-"));
const root = resolve(import.meta.dir, "..");
const key = `sk-not-a-real-key-${crypto.randomUUID()}`;
const home = join(dir, "home"), project = join(dir, "project");
mkdirSync(home, { recursive: true }); mkdirSync(project, { recursive: true });
const stand = join(dir, "codex-stand-in");
writeFileSync(stand, "#!/bin/sh\nexec sleep 600\n"); chmodSync(stand, 0o755);
Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1"], { stderr: "ignore" });
const kids = [
  spawn("bun", [join(root, "scripts/fake-responses.ts"), join(dir, "fake.log"), port, join(dir, "c.pem"), join(dir, "k.pem")], { stdio: "ignore" }),
];
const stop = () => { for (const k of kids) k.kill("SIGTERM"); };
const fail = (m: string) => { stop(); console.error(`FAIL ${m}`); process.exit(1); };
await Bun.sleep(700);
kids.push(spawn("bun", [join(root, "runner/src/adapters/codex/privateHost.ts"), home, project, "openai", `https://127.0.0.1:${port}/v1`, "cost-e2e", stand], { stdio: "ignore", env: { ...process.env, TETHER_GATEWAY_KEY: key } }));
for (let i = 0; i < 100 && !existsSync(join(home, "source.json")); i++) await Bun.sleep(50);
const { proxyBase } = JSON.parse(readFileSync(join(home, "source.json"), "utf8"));

async function turn(fake: object, extra: object = {}) {
  const response = await fetch(`${proxyBase}/responses`, {
    method: "POST", headers: { authorization: "Bearer tether-private-cost-e2e", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6-luna", stream: true, input: [], fake, ...extra }),
  });
  if (!response.ok) fail(`HTTP ${response.status}`);
  await response.text();
  await Bun.sleep(30);
  return new CostLedger(join(home, "costs.json")).get("cost-e2e");
}
const usage = (details: object, input_tokens = 150_000) => ({ usage: { input_tokens, output_tokens: 500, total_tokens: input_tokens + 500, input_tokens_details: { cached_tokens: 0, ...details } } });
const check = (name: string, cost: any, want: { complete: boolean; has?: string; usd?: number }) => {
  if (cost.complete !== want.complete) fail(`${name}: complete ${cost.complete}`);
  if (want.has && !cost.reasons?.includes(want.has)) fail(`${name}: reasons ${cost.reasons}`);
  if (want.usd !== undefined && Math.abs(cost.usd - want.usd) > 1e-9) fail(`${name}: usd ${cost.usd}, wanted ${want.usd}`);
  console.log(`ok  ${name}: ${costChip(cost).text} [${cost.reasons ?? ""}] (${cost.notes ?? ""})`);
};

try {
  // The prod session's shape, twice: 150,254 written, then 149,651 read and nothing new.
  const write = (150_254 * 0.125 + 500 * 0.5) / 1e6, read = (149_651 * 0.01 + 349 * 0.1 + 500 * 0.5) / 1e6;
  let cost = await turn({ ...usage({ cache_write_tokens: 150_254 }, 150_254) });
  check("no tier, no lifetimes", cost, { complete: true, usd: write });
  if (!cost.notes?.includes("no-cache-ttl") || !cost.notes.includes("tier:missing")) fail(`notes ${cost.notes}`);
  cost = await turn({ ...usage({ cached_tokens: 149_651, cache_write_tokens: 0 }) });
  check("a read", cost, { complete: true, usd: write + read });
  if (costChip(cost).text !== "$0.02 est.") fail(`chip ${costChip(cost).text}`);

  cost = await turn({ service_tier: "default", ...usage({ cache_write_tokens: 700, cache_write_tokens_details: { ttl_30m_tokens: 300, ttl_12h_tokens: 400 } }, 1000) });
  check("the guide's full breakdown", cost, { complete: true });
  const subtotal = cost.usd!;

  for (const [name, fake, has, extra] of [
    ["auto answered, 12h asked", { service_tier: "auto", ...usage({ cache_write_tokens: 1000 }) }, "no-cache-ttl", { prompt_cache_options: { ttl: "12h" } }],
    ["a tier served", { service_tier: "priority", ...usage({ cache_write_tokens: 0 }) }, "tier:priority"],
    ["a dated id", { model: "gpt-6-luna-2026-10-01", service_tier: "default", ...usage({ cache_write_tokens: 0 }) }, "model:gpt-6-luna-2026-10-01"],
    ["long context", { service_tier: "default", ...usage({ cache_write_tokens: 0 }, 272_001) }, "long-context"],
    ["a tool fee", { service_tier: "default", output: [{ type: "web_search_call" }], ...usage({ cache_write_tokens: 0 }) }, "tool-fee"],
    ["no usage", { usage: null }, "no-usage"],
  ] as [string, object, string, object?][]) {
    cost = await turn(fake, extra);
    check(name, cost, { complete: false, has });
    const chip = costChip(cost);
    if (!chip.text.startsWith("~$") || !chip.text.includes("+") || cost.usd! < subtotal) fail(`${name}: chip ${chip.text}`);
    console.log(`    ${chip.text} | ${chip.detail}`);
  }

  const file = readFileSync(join(home, "costs.json"), "utf8");
  const statuses = [...file.matchAll(/"(?:reasons|notes)":\[([^\]]*)\]/g)].map((m) => m[1]).join();
  if (file.includes(key) || file.includes("Fake reply")) fail("costs.json holds more than numbers and codes");
  if (statuses.replace(/"(no-usage|no-cache-ttl|tool-fee|long-context|(tier|model):[\w.:-]+)"|,/g, "")) fail(`reasons: ${statuses}`);
  console.log("ok  costs.json: only numbers, opaque ids and codes; no key");
  console.log("PASS");
} finally { stop(); }
process.exit(0);
