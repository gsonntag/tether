// A runner for looking at the plan-limit switch (SPEC §10) without an exhausted plan: the real core,
// credentials and billing ops behind a scripted harness, whose frames go through the real ClaudeStream
// and CodexStream, so each limit signal is parsed as the real thing would be. Keys are made up and
// nothing is called.
//   TETHER_CONFIG_DIR=<private dir> TETHER_URL=http://127.0.0.1:8899 bun scripts/limit-runner.ts [runnerId]
// What a message does depends on its words: "limit", "tools limit", "short 429", anything else answers.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ClaudeStream } from "../runner/src/adapters/claude/stream";
import { CodexStream } from "../runner/src/adapters/codex/stream";
import { CredentialStore } from "../runner/src/credentials";
import { saveConfig } from "../runner/src/config";
import { FakeAdapter, FakeDriver, type Step } from "../runner/src/core/fakeAdapter";
import { createRunner } from "../runner/src/core/runner";

const dir = process.env.TETHER_CONFIG_DIR!;
if (!dir?.startsWith("/tmp/")) throw new Error("Set TETHER_CONFIG_DIR to a private folder under /tmp.");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const runnerId = process.argv[2] ?? "tether-dev-auto";
const prefsFile = join(dir, "runner.json");
saveConfig({ runnerId }, prefsFile);
const P = join(dir, "project");
mkdirSync(P, { recursive: true });

const credentials = new CredentialStore(join(dir, "credentials.json"));
CredentialStore.current = credentials;
const fake = () => `fake-${crypto.randomUUID()}`;
credentials.set("anthropic", fake());
credentials.set("openai", fake());
credentials.set("azure", fake(), "https://fake.invalid", "fake-deployment");

const LIMIT = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:56 AM.";
const H = 3_600_000;
const allowed = () => ({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.12, resetsAt: Math.floor((Date.now() + 3 * H) / 1000) }, seven_day: { utilization: 0.64, resetsAt: Math.floor((Date.now() + 90 * H) / 1000) } } });

const onKey = (d: FakeDriver) => d.opts.credential?.source !== "subscription" && !!d.opts.credential?.source;
let n = 0;

const claude = new FakeAdapter();
claude.capabilities = { ...claude.capabilities, canSteer: true, sourceSwitch: true };
claude.storedBilling = async (id) => (runner.core.o.prefs.get(`claude:${id}`).source === "anthropic" ? { kind: "apiKey", label: "Anthropic API key" } : { kind: "plan", label: "Claude plan" });
const claudeStreams = new WeakMap<FakeDriver, ClaudeStream>();
claude.script = (text) => [
  (sink, d) => {
    let st = claudeStreams.get(d);
    if (!st) claudeStreams.set(d, (st = new ClaudeStream(sink, { nativeId: d.nativeId, keyed: () => onKey(d) })));
    const id = `m${++n}`;
    const frames = (...f: any[]) => f.forEach((x) => st!.handle(x));
    const say = (t: string) => ({ type: "assistant", uuid: `u${id}`, message: { id, model: "claude-haiku-5-5", role: "assistant", content: [{ type: "text", text: t }] } });
    const fail = (code: string, t: string, status: number) => [{ type: "assistant", uuid: `u${id}f`, error: code, message: { id: `${id}f`, model: "<synthetic>", role: "assistant", content: [{ type: "text", text: t }] } }, { type: "result", subtype: "success", is_error: true, result: t, api_error_status: status, uuid: `r${id}` }];
    st.mainStarts();
    sink.state({ billing: onKey(d) ? { kind: "apiKey", label: "Anthropic API key" } : { kind: "plan", label: "Claude plan" } });
    if (!onKey(d) && /short 429/.test(text)) return frames(...fail("rate_limit", "Server is temporarily limiting requests (not your usage limit)", 429));
    if (!onKey(d) && /limit/.test(text)) {
      const rejected = { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: Math.floor((Date.now() + 90 * H) / 1000) } };
      if (/tools/.test(text)) frames({ type: "assistant", uuid: `u${id}t`, message: { id: `${id}t`, model: "claude-haiku-5-5", role: "assistant", content: [{ type: "tool_use", id: `t${id}`, name: "Bash", input: { command: "date" } }] } }, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${id}`, content: "ok" }] } });
      return frames(rejected, ...fail("rate_limit", "You've hit your weekly limit · resets 6pm (UTC)", 429));
    }
    if (!onKey(d)) frames({ type: "rate_limit_event", rate_limit_info: allowed() });
    frames(say(`Fake reply ${n} on ${onKey(d) ? "the key" : "the plan"}.`), { type: "result", subtype: "success", is_error: false, result: "ok", uuid: `r${id}` });
  },
];

const codex = new FakeAdapter();
(codex as any).id = "codex";
codex.capabilities = { ...codex.capabilities, canSteer: true, terminal: "shared", sourceSwitch: true, sourceCarry: true };
codex.billing = {
  keys: ["openai", "azure"],
  label: (source) => (source === "openai" ? { kind: "apiKey", label: "OpenAI API key" } : source === "azure" ? { kind: "provider", label: "Azure" } : { kind: "plan", label: "ChatGPT plan" }),
  loggedIn: async () => true,
};
codex.storedBilling = async () => ({ kind: "plan", label: "ChatGPT plan" });
let reads = 0;
codex.planUsage = async () => {
  // What was last reported: three hours old until the third read, as if the harness had nothing newer.
  const at = ++reads < 3 ? Date.now() - 3 * H : Date.now();
  return { fiveHour: { percent: 100, resetsAt: Date.now() + 2 * H, at }, week: { percent: 41 + reads, resetsAt: Date.now() + 70 * H, at } };
};
const codexStreams = new WeakMap<FakeDriver, CodexStream>();
codex.script = (text) => [
  (sink, d) => {
    let st = codexStreams.get(d);
    if (!st) codexStreams.set(d, (st = new CodexStream(sink, P, d.nativeId)));
    const turn = `t${++n}`;
    const billing = d.opts.credential?.source === "azure" ? { kind: "provider" as const, label: "Azure" } : d.opts.credential?.source === "openai" ? { kind: "apiKey" as const, label: "OpenAI API key" } : { kind: "plan" as const, label: "ChatGPT plan" };
    sink.state({ billing });
    st.handle("turn/started", { turn: { id: turn } });
    if (!onKey(d) && /limit/.test(text)) return st.handle("turn/completed", { turn: { id: turn, status: "failed", error: { message: LIMIT, codexErrorInfo: "usageLimitExceeded", additionalDetails: null }, items: [] } });
    st.handle("item/completed", { item: { type: "agentMessage", id: `i${n}`, text: `Fake reply ${n} on ${billing.label}.` } });
    st.handle("turn/completed", { turn: { id: turn, status: "completed", items: [] } });
  },
];

const stored = (a: FakeAdapter, h: string, id: string, title: string) => a.addStored(id, [], { id: `${h}:${id}`, harness: h as any, projectPath: P, title });
stored(claude, "claude", "plan-a", "Claude plan: limit, resent");
stored(claude, "claude", "plan-b", "Claude plan: tools ran");
stored(claude, "claude", "plan-c", "Claude plan: short 429");
stored(claude, "claude", "key-a", "Claude on a key");
stored(codex, "codex", "codex-a", "Codex plan: carried");
saveConfig({ runnerId, sessions: { "claude:key-a": { source: "anthropic", projectPath: P } } } as any, prefsFile);

const runner = createRunner({
  url: process.env.TETHER_URL!,
  token: "dev",
  runnerId,
  name: runnerId,
  version: "0",
  credentials,
  prefsFile,
  costsFile: join(dir, "costs.json"),
  noticesFile: join(dir, "notices.json"),
  detectHarnesses: async () => [{ id: "claude", version: "fake" }, { id: "codex", version: "fake" }],
  adapters: [claude, codex],
  log: (l) => console.log(l),
});
let carried = 0;
runner.live.carrier = async (from, source) => {
  const nativeId = `carried-${++carried}`;
  stored(codex, "codex", nativeId, "Carried");
  return runner.look.sessions.adopt("codex", nativeId, P, {}, source, from);
};
runner.ops.register("planReads" as any, () => reads);
await runner.start();
console.log("limit runner up");
