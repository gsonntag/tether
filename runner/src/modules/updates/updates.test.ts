import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_MS, latestFromRegistry, realDeps, runCommand, UpdateChecker, type CheckerDeps, type RunResult } from "./check";
import { commandLine, detectInstall, updatePlan, type HarnessSpec } from "./install";

const CLAUDE: HarnessSpec = { id: "claude", name: "Claude Code", pkg: "@anthropic-ai/claude-code", bin: "claude", brew: "claude-code" };
const CODEX: HarnessSpec = { id: "codex", name: "Codex", pkg: "@openai/codex", bin: "codex", brew: "codex" };
const SDK: HarnessSpec = { id: "claude-agent-sdk", name: "Claude Agent SDK", pkg: "@anthropic-ai/claude-agent-sdk" };

test("install method from where the binary really lives", () => {
  expect(detectInstall("/home/u/.local/share/claude/versions/2.1.322", CLAUDE.pkg)).toEqual({ method: "native" });
  expect(detectInstall("/home/u/.nvm/versions/node/v22.22.2/lib/node_modules/@openai/codex/bin/codex.js", CODEX.pkg)).toEqual({ method: "npm", prefix: "/home/u/.nvm/versions/node/v22.22.2" });
  expect(detectInstall("/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", CLAUDE.pkg)).toEqual({ method: "npm", prefix: "/usr" });
  expect(detectInstall("/home/u/.bun/install/global/node_modules/@openai/codex/bin/codex.js", CODEX.pkg)).toEqual({ method: "bun" });
  expect(detectInstall("/opt/homebrew/Caskroom/codex/0.164.0/codex", CODEX.pkg)).toEqual({ method: "brew" });
  expect(detectInstall("/home/linuxbrew/.linuxbrew/Cellar/claude-code/2.1.0/bin/claude", CLAUDE.pkg)).toEqual({ method: "brew" });
  expect(detectInstall("/usr/local/bin/codex", CODEX.pkg)).toEqual({ method: "unknown" });
  // another package's node_modules isn't this one's install
  expect(detectInstall("/usr/lib/node_modules/other/bin/codex", CODEX.pkg)).toEqual({ method: "unknown" });
});

test("the update command follows the install method", () => {
  const npm = updatePlan(CODEX, { method: "npm", prefix: "/n/v22" }, "0.167.1", "/n/v22/bin/codex", "/usr/bin");
  expect(npm).toEqual({ argv: ["/n/v22/bin/npm", "install", "-g", "@openai/codex@0.167.1"], env: { PATH: "/n/v22/bin:/usr/bin" } });
  expect(updatePlan(CLAUDE, { method: "native" }, "2.1.330", "/h/.local/bin/claude")).toEqual({ argv: ["/h/.local/bin/claude", "update"] });
  expect(updatePlan(CODEX, { method: "bun" }, undefined, "x")).toEqual({ argv: ["bun", "add", "-g", "@openai/codex@latest"] });
  expect(updatePlan(CLAUDE, { method: "brew" }, "1", "x")).toEqual({ argv: ["brew", "upgrade", "claude-code"] });
  expect(updatePlan(SDK, { method: "bundled" }, "1", undefined)).toBeUndefined();
  expect(updatePlan(CODEX, { method: "unknown" }, "1", "x")).toBeUndefined();
  expect(commandLine({ argv: ["/n/bin/npm", "install", "-g", "x@1"] })).toBe("/n/bin/npm install -g x@1");
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("the registry's latest, with a timeout and short reasons when it fails", async () => {
  expect(await latestFromRegistry("@openai/codex", "latest", { fetch: async () => json({ latest: "0.167.1", alpha: "0.170.0-alpha.1" }) })).toBe("0.167.1");
  expect(await latestFromRegistry("@anthropic-ai/claude-code", "stable", { fetch: async () => json({ latest: "2.1.322", stable: "2.1.311" }) })).toBe("2.1.311");
  await expect(latestFromRegistry("x", "latest", { fetch: async () => json({}, 404) })).rejects.toThrow("answered 404");
  await expect(latestFromRegistry("x", "latest", { fetch: async () => json({ latest: 5 }) })).rejects.toThrow('no "latest" version');
  await expect(latestFromRegistry("x", "latest", { fetch: async () => { throw new TypeError("getaddrinfo ENOTFOUND"); } })).rejects.toThrow("couldn't reach the npm registry");
  const hang = (_: string, init: { signal: AbortSignal }) => new Promise<Response>((_, no) => init.signal.addEventListener("abort", () => no(new Error("aborted"))));
  await expect(latestFromRegistry("x", "latest", { fetch: hang }, 50)).rejects.toThrow("didn't answer in 0 s");
});

test("a command that hangs is killed at its time limit; a missing one doesn't throw", async () => {
  const slow = await runCommand(["sh", "-c", "echo started; sleep 10"], { timeoutMs: 200 });
  expect(slow.timedOut).toBe(true);
  expect(slow.code).toBeNull();
  expect(slow.output).toContain("started");
  const missing = await runCommand(["/nonexistent/tether-bin"], { timeoutMs: 1000 });
  expect(missing.code).toBeNull();
});

function fakeDeps(over: Partial<CheckerDeps> & { versions?: Record<string, string>; tags?: Record<string, Record<string, string>> } = {}) {
  let now = 1_000_000;
  const calls = { fetch: 0, run: [] as string[][] };
  const versions: Record<string, string> = { "/bin/claude": "2.1.300 (Claude Code)", "/bin/codex": "codex-cli 0.164.0", ...over.versions };
  const tags = over.tags ?? { "@anthropic-ai/claude-code": { latest: "2.1.322", stable: "2.1.311" }, "@openai/codex": { latest: "0.167.1" }, "@anthropic-ai/claude-agent-sdk": { latest: "0.3.322" } };
  const deps: CheckerDeps = {
    which: (b) => `/bin/${b}`,
    realpath: (p) => (p === "/bin/claude" ? "/h/.local/share/claude/versions/2.1.300" : "/n/v22/lib/node_modules/@openai/codex/bin/codex.js"),
    run: async (argv): Promise<RunResult> => {
      calls.run.push(argv);
      if (argv[1] === "--version") return { code: 0, output: versions[argv[0]!] ?? "", timedOut: false };
      return { code: 0, output: "updated", timedOut: false };
    },
    fetch: async (url) => {
      calls.fetch++;
      const pkg = decodeURIComponent(url.split("/-/package/")[1]!.replace("/dist-tags", ""));
      return tags[pkg] ? json(tags[pkg]) : json({}, 404);
    },
    bundledVersion: () => "0.3.312",
    claudeChannel: () => "latest",
    now: () => now,
    ...over,
  };
  return { deps, calls, versions, tick: (ms: number) => (now += ms) };
}

test("a report: installed, latest, method, update command, and a cache of a few minutes", async () => {
  const f = fakeDeps();
  const c = new UpdateChecker(f.deps, [CLAUDE, CODEX, SDK]);
  const r = await c.report();
  const [claude, codex, sdk] = r.harnesses;
  expect(claude).toMatchObject({ id: "claude", installed: "2.1.300", latest: "2.1.322", status: "available", method: "native", updatable: true, command: "/bin/claude update" });
  expect(codex).toMatchObject({ installed: "0.164.0", latest: "0.167.1", status: "available", method: "npm", updatable: true, command: "/n/v22/bin/npm install -g @openai/codex@0.167.1" });
  expect(codex!.note).toContain("app server");
  expect(sdk).toMatchObject({ installed: "0.3.312", latest: "0.3.322", status: "available", method: "bundled", updatable: false });
  expect(f.calls.fetch).toBe(3);
  await c.report();
  expect(f.calls.fetch).toBe(3); // cached
  f.tick(CACHE_MS);
  await c.report();
  expect(f.calls.fetch).toBe(6);
  await c.report(true);
  expect(f.calls.fetch).toBe(9);
});

test("Claude's native install follows its update channel", async () => {
  const f = fakeDeps({ claudeChannel: () => "stable", versions: { "/bin/claude": "2.1.311 (Claude Code)" } });
  const r = await new UpdateChecker(f.deps, [CLAUDE]).report();
  expect(r.harnesses[0]).toMatchObject({ latest: "2.1.311", status: "current" });
});

test("a registry that's down shows as couldn't check; a missing harness as not installed", async () => {
  const f = fakeDeps({ fetch: async () => { throw new Error("ECONNREFUSED"); }, which: (b) => (b === "codex" ? null : `/bin/${b}`) });
  const r = await new UpdateChecker(f.deps, [CLAUDE, CODEX]).report();
  expect(r.harnesses[0]).toMatchObject({ status: "unknown", installed: "2.1.300", error: expect.stringContaining("couldn't reach the npm registry") });
  expect(r.harnesses[0]!.latest).toBeUndefined();
  expect(r.harnesses[1]).toMatchObject({ status: "missing", updatable: false });
});

test("a --version that fails or times out leaves the harness without a version, not a crash", async () => {
  const f = fakeDeps({ run: async () => ({ code: null, output: "", timedOut: true }) });
  const r = await new UpdateChecker(f.deps, [CODEX]).report();
  expect(r.harnesses[0]).toMatchObject({ status: "missing" });
});

test("an update runs the install's command in the background, one at a time, and shows its result", async () => {
  const f = fakeDeps();
  let release!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  const ran: string[][] = [];
  f.deps.run = async (argv, opts) => {
    if (argv[1] === "--version") return { code: 0, output: f.versions[argv[0]!] ?? "", timedOut: false };
    ran.push(argv);
    opts.onOutput?.("working…\n");
    await gate;
    if (argv[0] === "/bin/claude") f.versions["/bin/claude"] = "2.1.322 (Claude Code)";
    else f.versions["/bin/codex"] = "codex-cli 0.167.1";
    return { code: 0, output: "working…\nadded 1 package", timedOut: false };
  };
  const c = new UpdateChecker(f.deps, [CLAUDE, CODEX, SDK]);
  const started = await c.update("claude");
  expect(started.harnesses[0]!.update).toMatchObject({ command: "/bin/claude update", from: "2.1.300" });
  const second = await c.update("codex");
  await Bun.sleep(5);
  const mid = await c.report();
  expect(mid.harnesses[0]!.update).toMatchObject({ state: "running", output: "working…\n" });
  expect(mid.harnesses[1]!.update!.state).toBe("queued");
  expect(second.harnesses[1]!.update!.command).toBe("/n/v22/bin/npm install -g @openai/codex@0.167.1");
  expect(ran.length).toBe(1); // the second waits for the first
  release();
  for (let i = 0; i < 50 && (await c.report()).harnesses.some((h) => h.update?.state === "running" || h.update?.state === "queued"); i++) await Bun.sleep(5);
  const done = await c.report();
  expect(done.harnesses[0]).toMatchObject({ installed: "2.1.322", status: "current", update: { state: "done", from: "2.1.300", to: "2.1.322" } });
  expect(done.harnesses[1]).toMatchObject({ installed: "0.167.1", status: "current", update: { state: "done", to: "0.167.1" } });
  expect(ran).toEqual([["/bin/claude", "update"], ["/n/v22/bin/npm", "install", "-g", "@openai/codex@0.167.1"]]);
});

test("updates that can't or shouldn't run are refused; a failing one is reported", async () => {
  const f = fakeDeps();
  f.deps.run = async (argv) => (argv[1] === "--version" ? { code: 0, output: f.versions[argv[0]!] ?? "", timedOut: false } : { code: 1, output: "npm ERR! EACCES", timedOut: false });
  const c = new UpdateChecker(f.deps, [CLAUDE, CODEX, SDK]);
  await expect(c.update("claude-agent-sdk")).rejects.toThrow("Tether release");
  await expect(c.update("nope")).rejects.toThrow('no harness "nope"');
  await c.update("codex");
  for (let i = 0; i < 50 && (await c.report()).harnesses[1]!.update?.state !== "failed"; i++) await Bun.sleep(5);
  expect((await c.report()).harnesses[1]!.update).toMatchObject({ state: "failed", error: "It exited with code 1.", output: "npm ERR! EACCES" });
  const g = fakeDeps({ versions: { "/bin/claude": "2.1.322 (Claude Code)" } });
  await expect(new UpdateChecker(g.deps, [CLAUDE]).update("claude")).rejects.toThrow("up to date");
});

test("bundled version reads the runner's own dependency", () => {
  expect(realDeps.bundledVersion("@anthropic-ai/claude-agent-sdk")).toMatch(/^\d+\.\d+\.\d+/);
  expect(realDeps.bundledVersion("@nope/missing")).toBeUndefined();
});

test("a which of a path checks it exists", () => {
  const d = mkdtempSync(join(tmpdir(), "tether-upd-"));
  const p = join(d, "codex");
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, 0o755);
  expect(realDeps.which(p)).toBe(p);
  expect(realDeps.which(join(d, "missing"))).toBeNull();
  rmSync(d, { recursive: true });
});

test("the Home agent's check_harness_updates lines", async () => {
  const { harnessUpdateLines } = await import("../homeAgent");
  const f = fakeDeps();
  const text = harnessUpdateLines(await new UpdateChecker(f.deps, [CLAUDE, CODEX, SDK]).report());
  expect(text).toContain("- Codex: 0.164.0, latest 0.167.1 — Update available (updates with `/n/v22/bin/npm install -g @openai/codex@0.167.1`)");
  expect(text).toContain("- Claude Agent SDK: 0.3.312, latest 0.3.322 — Needs a Tether release");
  expect(text).toContain("Settings → Updates");
});
