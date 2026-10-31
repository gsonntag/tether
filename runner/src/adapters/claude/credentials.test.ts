import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CredentialSnapshot } from "../../credentials";
import { Transcript } from "../../core/transcript";
import { ClaudeDriver } from "./driver";
import { CLAUDE_AUTH_ENV, claudeAuthSettings, claudeEnv, claudeKeyLease, claudeTerminalScripts, confirmClaudeBilling, prepareClaudeTerminal } from "./credentials";
import { ClaudeCostCounter } from "./cost";
import { ClaudeStream } from "./stream";
import { claudeAdapter } from "./index";

const base = "/tmp/claude-1001/keys/unit";
test("read-only terminal screen/quit metadata needs no launch credentials, while a launch does", () => {
  expect(claudeAdapter.terminalCommand("stored-id", "/tmp", {}).screen).toBeDefined();
  expect(() => claudeAdapter.terminalCommand("stored-id", "/tmp", { fresh: false })).toThrow("cannot confirm its billing source");
});
const fresh = () => { mkdirSync(base, { recursive: true }); return mkdtempSync(join(base, "claude-")); };
function credential(): CredentialSnapshot {
  const file = join(fresh(), "credentials.json");
  const c: CredentialSnapshot = { source: "anthropic", revision: randomBytes(8).toString("hex"), key: `sk-ant-test-${randomBytes(24).toString("hex")}`, file };
  writeFileSync(file, JSON.stringify({ version: 1, anthropic: { key: c.key, revision: c.revision } }), { mode: 0o600 });
  return c;
}

test("subscription removes inherited keys, tokens, proxy routes and provider switches", () => {
  const inherited = Object.fromEntries(CLAUDE_AUTH_ENV.map((k) => [k, "inherited"]));
  const env = claudeEnv({ source: "subscription", revision: "subscription" }, { ...inherited, PATH: "/bin", TETHER_TOKEN: "runner-secret", DEBUG: "*", TETHER_CLAUDE_API_KEY: "retired", OPENAI_API_KEY: "other-source", AZURE_OPENAI_API_KEY: "other-source" });
  expect(CLAUDE_AUTH_ENV.every((k) => env[k] === undefined)).toBe(true);
  expect(env.PATH).toBe("/bin");
  expect(env.TETHER_TOKEN).toBeUndefined();
  expect(env.TETHER_CLAUDE_API_KEY).toBeUndefined();
  expect(env.DEBUG).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.AZURE_OPENAI_API_KEY).toBeUndefined();
  expect(claudeAuthSettings().apiKeyHelper).toBe("");
});

test("the selected key stays in the private lease, never harness env, settings or command arguments", () => {
  const c = credential();
  const lease = claudeKeyLease(c);
  const settings = claudeAuthSettings(lease.helper);
  expect(claudeEnv(c).TETHER_CLAUDE_API_KEY).toBeUndefined();
  expect(claudeEnv(c).ANTHROPIC_API_KEY).toBeUndefined();
  expect(JSON.stringify(settings)).not.toContain(c.key!);
  for (const file of readdirSync(join(c.file!, "..", "claude-launch"))) {
    const path = join(c.file!, "..", "claude-launch", file);
    expect(readFileSync(path, "utf8")).not.toContain(c.key!);
    expect(statSync(path).mode & 0o777).toBe(0o700);
  }
  lease.close();
});

test("a process lease keeps its original key after the credentials file changes", async () => {
  const c = credential();
  const lease = claudeKeyLease(c);
  try {
    writeFileSync(c.file!, '{"version":1}', { mode: 0o600 });
    const p = Bun.spawn(["/bin/sh", "-c", lease.helper], { env: claudeEnv(c), stdout: "pipe", stderr: "pipe" });
    const [status, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect(status).toBe(0);
    expect(out).toBe(c.key!);
    expect(err).toBe("");
  } finally { lease.close(); }
});

test("billing confirmation rejects unknown, proxy/provider, login on key, and key on subscription", () => {
  const key = { source: "anthropic", revision: "r", key: "fake" } as CredentialSnapshot;
  const plan = { source: "subscription", revision: "subscription" } as CredentialSnapshot;
  expect(confirmClaudeBilling({ apiProvider: "firstParty", apiKeySource: "apiKeyHelper", tokenSource: "claude.ai" }, key).label).toBe("Anthropic API key");
  expect(confirmClaudeBilling({ apiProvider: "firstParty", apiKeySource: "none", tokenSource: "claude.ai", subscriptionType: "max" }, plan).kind).toBe("plan");
  for (const account of [undefined, {}, { apiProvider: "bedrock" }, { subscriptionType: "max" }]) expect(() => confirmClaudeBilling(account, key)).toThrow("Sending is blocked");
  expect(() => confirmClaudeBilling({ apiProvider: "bedrock", apiKeySource: "apiKeyHelper" }, key)).toThrow("Sending is blocked");
  expect(() => confirmClaudeBilling({ apiKeySource: "apiKeyHelper" }, key)).toThrow("Sending is blocked");
  expect(() => confirmClaudeBilling({ apiProvider: "bedrock", subscriptionType: "max" }, plan)).toThrow("Sending is blocked");
  expect(() => confirmClaudeBilling({ apiKeySource: "ANTHROPIC_API_KEY" }, plan)).toThrow("Sending is blocked");
  expect(() => confirmClaudeBilling({ apiKeySource: "ANTHROPIC_API_KEY" }, key)).toThrow("Sending is blocked");
  expect(() => confirmClaudeBilling({ subscriptionType: "max", tokenSource: "ANTHROPIC_AUTH_TOKEN" }, plan)).toThrow("Sending is blocked");
});

test("launcher reads its exact revision, redacts split terminal echoes and keeps keys out of cmdline/files", async () => {
  const c = credential();
  const { launcher } = claudeTerminalScripts(c.file!);
  const target = join(dirname(c.file!), "target.mjs");
  writeFileSync(target, `const settings=JSON.parse(process.argv[3]);
const helper=Bun.spawnSync(['/bin/sh','-c',settings.apiKeyHelper],{env:process.env});
const key=helper.stdout.toString();
if (!key || process.env.TETHER_CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || !process.stdout.isTTY) process.exit(9);
const cmdline=await Bun.file('/proc/'+process.pid+'/cmdline').text();
if(cmdline.includes(key)) process.exit(10);
if(helper.exitCode!==0) process.exit(11);
process.stdout.write(key.slice(0,8)); await Bun.sleep(20); process.stdout.write(key.slice(8));
process.stdout.write('verified');\n`);
  const p = Bun.spawn([process.execPath, launcher, c.file!, c.revision, c.source, process.execPath, target, "--settings", JSON.stringify(claudeAuthSettings())], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [status, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  expect(status).toBe(0);
  expect(out).toContain("[redacted]verified");
  expect(out + err).not.toContain(c.key!);
  expect(readFileSync(target, "utf8")).not.toContain(c.key!);
  expect(readFileSync(launcher, "utf8")).not.toContain(c.key!);
  const partialTarget = join(dirname(c.file!), "partial.mjs");
  writeFileSync(partialTarget, "const s=JSON.parse(process.argv[3]);const h=Bun.spawnSync(['/bin/sh','-c',s.apiKeyHelper]);process.stdout.write(h.stdout.toString().slice(0,-1));");
  const partial = Bun.spawn([process.execPath, launcher, c.file!, c.revision, c.source, process.execPath, partialTarget, "--settings", JSON.stringify(claudeAuthSettings())], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(await partial.exited).toBe(0);
  expect(await new Response(partial.stdout).text()).toBe("");
  const stale = Bun.spawn([process.execPath, launcher, c.file!, "stale", c.source, process.execPath, target, "--settings", JSON.stringify(claudeAuthSettings())], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(await stale.exited).toBe(1);
  expect(await new Response(stale.stderr).text()).toContain("billing could not be confirmed");
});

test("subscription launcher rejects a key set after preflight and otherwise clears inherited auth", async () => {
  const c = credential();
  const { launcher } = claudeTerminalScripts(c.file!);
  const argv = [process.execPath, launcher, c.file!, "subscription", "subscription", process.execPath, "-e", "if(process.env.ANTHROPIC_API_KEY||process.env.TETHER_CLAUDE_API_KEY)process.exit(5);console.log('subscription')", "--settings", JSON.stringify(claudeAuthSettings())];
  const blocked = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(await blocked.exited).toBe(1);
  writeFileSync(c.file!, '{"version":1}', { mode: 0o600 });
  const restored = Bun.spawn(argv, { env: { ...process.env, ANTHROPIC_API_KEY: c.key!, TETHER_CLAUDE_API_KEY: c.key! }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(await restored.exited).toBe(0);
  expect(await new Response(restored.stdout).text()).toContain("subscription");
});

test("read-only TUI preflight confirms helper auth and refuses an unconfirmed source", async () => {
  const c = credential();
  const binary = join(dirname(c.file!), "auth-status");
  writeFileSync(binary, '#!/bin/sh\nprintf \'%s\' \'{"loggedIn":true,"apiProvider":"firstParty","apiKeySource":"apiKeyHelper"}\'\n', { mode: 0o700 });
  expect((await prepareClaudeTerminal(binary, c)).label).toBe("Anthropic API key");
  writeFileSync(binary, '#!/bin/sh\nprintf \'%s\' \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","apiKeySource":"none"}\'\n', { mode: 0o700 });
  await expect(prepareClaudeTerminal(binary, c)).rejects.toThrow("Sending is blocked");
  writeFileSync(binary, '#!/bin/sh\nprintf \'%s\' \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","apiKeySource":"none","tokenSource":"claude.ai"}\'\n', { mode: 0o700 });
  expect((await prepareClaudeTerminal(binary, { source: "subscription", revision: "subscription" })).kind).toBe("plan");
});

test("a key API failure stops once and emits only a source-specific error, without fallback advice", () => {
  const transcript = new Transcript();
  const events: unknown[] = [];
  let stops = 0;
  const sink: any = { event: (e: any) => { events.push(e); transcript.apply(e); }, message: (id: string) => transcript.get(id), state() {} };
  const stream = new ClaudeStream(sink, { nativeId: "fake", failed: () => { stops++; return "Anthropic API key failed. The session stopped. Check Credentials."; } });
  stream.handle({ type: "system", subtype: "api_retry", error: { message: "401 invalid key raw provider secret" } });
  expect(stops).toBe(1);
  expect(JSON.stringify(events)).toContain("Anthropic API key failed");
  expect(JSON.stringify(events)).not.toContain("raw provider secret");
  stream.handle({ type: "assistant", uuid: "x", error: "authentication_failed", message: { id: "a", content: [{ type: "text", text: "401 provider raw secret" }] } });
  expect(stops).toBe(2);
  expect(JSON.stringify(events)).toContain("Anthropic API key failed");
  expect(JSON.stringify(events)).not.toContain("provider raw secret");
  expect(JSON.stringify(events)).not.toContain("log in");
  stream.handle({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["network down"] });
  expect(stops).toBe(3);
});

test("an intentional interruption does not classify the stopped API turn as a key failure", () => {
  let failures = 0;
  const stream = new ClaudeStream({ state() {}, message() {}, event() {} } as any, { nativeId: "fake", interrupted: () => true, failed: () => { failures++; return "failed"; } });
  stream.handle({ type: "result", subtype: "error_during_execution", is_error: true });
  expect(failures).toBe(0);
});

test("an API-key failure invalidates the current cost epoch before it shuts down", () => {
  const reports: any[] = [];
  const driver: any = Object.create(ClaudeDriver.prototype);
  driver.closed = true;
  driver.credential = { source: "anthropic", revision: "fake", key: "unused" };
  driver.costs = new ClaudeCostCounter(0);
  driver.sink = { cost: (report: any) => reports.push(report), state() {} };
  reports.push(driver.costs.report(0.012));
  expect(driver.failed()).toBe("Anthropic API key failed. The session stopped. Check Credentials.");
  expect(reports[0]).toMatchObject({ usd: 0.012, estimated: true, complete: true });
  expect(reports[1]).toMatchObject({ id: reports[0].id, estimated: true, complete: false });
  expect(reports[1]).not.toHaveProperty("usd");
});

function dirname(file: string) { return join(file, ".."); }
