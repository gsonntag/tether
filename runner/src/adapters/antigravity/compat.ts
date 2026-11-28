// Compatibility acceptance checks for Antigravity (docs/acceptance/ANTIGRAVITY.md, issue #121).
// Antigravity auto-updates itself, and Tether relies on undocumented interfaces:
// 1. Hidden `agy acp` server and its message shapes (initialize, session/load, session/list, session/new)
// 2. Reading a subagent's first stored step (`sender=<parent id>`) to find its conversation
// 3. Copying conversation stores for forks (VACUUM INTO + UUID rewriting in protobuf and SQLite tables)
// 4. The TUI's screen text for terminal "Needs you" (prompt box, spinner, permission & trust prompts)
//
// These checks run a short, cheap version of the acceptance checks without spending tokens by default,
// usable both automatically by the runner when a new `agy` version is seen, and by hand via
// `scripts/antigravity-compat.ts`.

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AcpClient } from "../acp/client";
import { HARNESS_BINS, parseVersion } from "../detect";
import { copyStore, discardStore } from "./fork";
import { Tmux } from "../../terminal/tmux";
import { AGY_QUIT, agyScreen } from "./screen";
import { agyHome, conversationFile, reader } from "./store";
import { parentMessage } from "./subagents";
import { runCommand, type RunResult } from "../../modules/updates/check";

export interface CheckItem {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface CompatCheckResult {
  ok: boolean;
  version?: string;
  checks: CheckItem[];
  error?: string;
  output: string;
}

export interface CompatOptions {
  /** Path to agy binary; defaults to HARNESS_BINS.antigravity */
  bin?: string;
  /** Whether to run a live prompt turn (spends a few tokens); default false */
  live?: boolean;
}

export interface CompatDeps {
  which: (bin: string) => string | null;
  run: (argv: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }) => Promise<RunResult>;
  initAcp?: (bin: string) => Promise<{ version?: string; capabilities?: any; configOptions?: any[]; listCount?: number }>;
  testStoreAndFork?: () => Promise<{ integrity: boolean; replayed: boolean }>;
  /** `detail`: what was checked against agy itself, and what only against Tether's own sample */
  testSubagentFormat?: () => Promise<{ ok: boolean; detail: string }>;
  /** Tether's screen reader on the installed TUI's own screens; `skipped`: it couldn't be run here (no tmux) */
  testScreenParsing?: (bin: string) => Promise<{ ok: boolean; detail: string; skipped?: boolean }>;
  testLiveTurn?: (bin: string) => Promise<boolean>;
}

/** Subagent first steps among the newest conversations in `dir` (a first step that is "[Message] …"), and how many no longer decode. */
export function realSubagentSteps(dir: string, max = 200): { found: number; failed: number } {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".db"));
  } catch {
    return { found: 0, failed: 0 };
  }
  const at = (f: string) => {
    try {
      return statSync(join(dir, f)).mtimeMs;
    } catch {
      return 0;
    }
  };
  let found = 0;
  let failed = 0;
  for (const f of names.map((f) => ({ f, t: at(f) })).sort((a, b) => b.t - a.t).slice(0, max)) {
    let db: Database | undefined;
    try {
      db = new Database(join(dir, f.f), { readonly: true });
      const row = db.query("select step_payload from steps where idx = 0").get() as { step_payload?: Uint8Array } | null;
      if (!row?.step_payload || !Buffer.from(row.step_payload).toString("latin1").includes("[Message]")) continue;
      found++;
      if (!parentMessage(row.step_payload)) failed++;
    } catch {
      // mid-write, locked, or not a conversation: not one to judge by
    } finally {
      db?.close();
    }
  }
  return { found, failed };
}

/** Polls the screen until `want` holds of what agyScreen reads; the last screen either way. */
async function waitScreen(tmux: Tmux, name: string, want: (r: ReturnType<typeof agyScreen>) => boolean, ms: number): Promise<{ ok: boolean; screen: string }> {
  const end = Date.now() + ms;
  let screen = "";
  for (;;) {
    screen = await tmux.capture(name).catch(() => screen);
    if (want(agyScreen(screen))) return { ok: true, screen };
    if (Date.now() > end) return { ok: false, screen };
    await Bun.sleep(250);
  }
}

const tail = (screen: string) => screen.split("\n").map((l) => l.trim()).filter(Boolean).slice(-4).join(" | ").slice(0, 300);

/**
 * The installed TUI's own screens, as terminal mode reads them: started in a throwaway tmux in a new
 * folder, it asks to trust it (Needs you); trusted for this run only (`--settings`, never saved), it
 * shows its idle prompt box, then what's typed in it. Nothing is sent, so it spends no tokens.
 */
export async function realScreenCheck(bin: string, o: { timeoutMs?: number } = {}): Promise<{ ok: boolean; detail: string; skipped?: boolean }> {
  if (!Bun.which("tmux")) return { ok: true, skipped: true, detail: "tmux isn't installed, so terminal mode can't run here" };
  const ms = o.timeoutMs ?? 20_000;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tether-agy-screen-")));
  const tmux = new Tmux({ socket: `tether-agy-compat-${process.pid}`, log: () => {} });
  const start = (name: string, argv: string[]) => tmux.create({ name, cwd: dir, argv, cols: 120, rows: 40, tags: {} });
  try {
    await start("trust", [bin]);
    // A folder inside one agy already trusts (a temp folder under a trusted home) gets no question.
    const trust = await waitScreen(tmux, "trust", (r) => r.state === "asking" || (r.state === "idle" && r.prompt === "normal"), ms);
    if (!trust.ok) return { ok: false, detail: `the folder-trust question wasn't read as Needs you (screen: ${tail(trust.screen)})` };
    const asked = agyScreen(trust.screen).state === "asking";
    await tmux.kill("trust");
    await start("prompt", [bin, "--settings", JSON.stringify({ trustedWorkspaces: [dir] })]);
    const idle = await waitScreen(tmux, "prompt", (r) => r.state === "idle" && r.prompt === "normal" && !r.input, ms);
    if (!idle.ok) return { ok: false, detail: `the idle prompt box wasn't recognized (screen: ${tail(idle.screen)})` };
    const words = "tether compatibility check";
    await tmux.type("prompt", words);
    const typed = await waitScreen(tmux, "prompt", (r) => r.state === "idle" && r.input === words, 5_000);
    if (!typed.ok) return { ok: false, detail: `text typed in the prompt box wasn't read back (screen: ${tail(typed.screen)})` };
    // Quit as terminal mode does (text typed: Esc, then Ctrl-Cs); whatever is left goes with the tmux server.
    for (const step of AGY_QUIT) "keys" in step ? await tmux.keys("prompt", ...step.keys).catch(() => {}) : "waitMs" in step && (await Bun.sleep(step.waitMs));
    return { ok: true, detail: `${asked ? "trust question, " : ""}idle prompt box and typed text read from the real TUI${asked ? "" : " (temp folder already trusted: trust question not seen)"}` };
  } finally {
    await tmux.killServer().catch(() => {});
    // tmux leaves its socket file behind: one per check would pile up.
    if (process.getuid) rmSync(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid()}`, tmux.socket), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

export const realCompatDeps: CompatDeps = {
  which: (bin) => (bin.includes("/") ? (existsSync(bin) ? bin : null) : Bun.which(bin)),
  run: (argv, opts) => runCommand(argv, { timeoutMs: opts?.timeoutMs ?? 15_000, env: opts?.env }),
  async initAcp(bin: string) {
    const csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN || randomUUID();
    const tmp = mkdtempSync(join(tmpdir(), "tether-agy-init-"));
    const c = new AcpClient({
      argv: [bin, "acp"],
      cwd: homedir(),
      env: { ANTIGRAVITY_CSRF_TOKEN: csrfToken },
      name: "Antigravity",
      onUpdate: () => {},
    });
    let sid: string | undefined;
    try {
      await c.initialize();
      const version = c.agent?.version;
      const capabilities = c.agent?.capabilities;
      // agy 1.5.19 rejects session/load for unknown session ids: create a throwaway session to verify session/new, session/load, and configOptions.
      const created = await c.call("session/new", { cwd: tmp, mcpServers: [] });
      sid = typeof created?.sessionId === "string" ? created.sessionId : undefined;
      if (!sid) throw new Error("session/new returned no sessionId");
      const loadRes = await c.call("session/load", { sessionId: sid, cwd: tmp, mcpServers: [] });
      const listRes = await c.call("session/list", {});
      const listCount = Array.isArray(listRes?.sessions) ? listRes.sessions.length : undefined;
      await c.call("session/close", { sessionId: sid }, 5000).catch(() => {});
      return { version, capabilities, configOptions: loadRes?.configOptions ?? created?.configOptions, listCount };
    } finally {
      await c.close().catch(() => {});
      if (sid) discardStore(sid);
      rmSync(tmp, { recursive: true, force: true });
    }
  },
  async testStoreAndFork() {
    const tmp = mkdtempSync(join(tmpdir(), "tether-agy-compat-"));
    const origId = await reader.create(tmp);
    const forkId = randomUUID();
    let integrity = false;
    let replayed = false;
    try {
      copyStore(origId, forkId);
      const db = new Database(conversationFile(forkId), { readonly: true });
      try {
        const row = db.query("PRAGMA integrity_check").get() as { integrity_check?: string } | null;
        integrity = row?.integrity_check === "ok";
      } finally {
        db.close();
      }
      const res = await reader.replay(forkId, tmp);
      replayed = Array.isArray(res.msgs);
    } finally {
      discardStore(origId);
      discardStore(forkId);
      rmSync(tmp, { recursive: true, force: true });
    }
    return { integrity, replayed };
  },
  async testSubagentFormat() {
    // 1. Tether's decoder on the line shape agy wrote when this was checked (1.5.13): a self-test only.
    const sample = new Uint8Array(
      Buffer.from("\x12\x0a..$abc\x1a[Message] timestamp=2026-11-21T00:37:56Z sender=4afd15cc-2c80-4b26-adbc-60918bcdeee5 priority=MESSAGE_PRIORITY_HIGH content=Please run ls here.\x0a\x12more", "latin1"),
    );
    const parsed = parentMessage(sample);
    if (!parsed || parsed.parent !== "4afd15cc-2c80-4b26-adbc-60918bcdeee5" || parsed.prompt !== "Please run ls here.") {
      return { ok: false, detail: "Tether's decoder fails its own sample" };
    }
    // 2. The real subagent conversations agy wrote on this machine, newest first: each must still decode.
    const real = realSubagentSteps(join(agyHome(), "conversations"));
    if (real.failed) return { ok: false, detail: `${real.failed} of ${real.found} subagent first steps on disk no longer decode (sender=<parent id> … content=)` };
    if (!real.found) return { ok: true, detail: "no subagent conversation on this machine to check against; decoder self-test only" };
    return { ok: true, detail: `${real.found} subagent conversations on disk decoded` };
  },
  async testScreenParsing(bin: string) {
    return realScreenCheck(bin);
  },
  async testLiveTurn(bin: string) {
    const csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN || randomUUID();
    // The client reads its callbacks from these options only: the reply's text arrives through onUpdate.
    let sessionId: string | undefined;
    let gotText = "";
    const c = new AcpClient({
      argv: [bin, "acp"],
      cwd: homedir(),
      env: { ANTIGRAVITY_CSRF_TOKEN: csrfToken },
      name: "Antigravity",
      onUpdate: (sid, u) => {
        if (sid === sessionId && u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") gotText += u.content.text;
      },
      // A check asks nothing of tools; were it asked, it declines, as the store's reader does.
      onRequest: async (method) => (method === "session/request_permission" ? { outcome: { outcome: "cancelled" } } : Promise.reject(new Error("Not supported."))),
    });
    try {
      await c.initialize();
      const tmp = mkdtempSync(join(tmpdir(), "tether-agy-live-"));
      try {
        sessionId = ((await c.call("session/new", { cwd: tmp, mcpServers: [] })) as { sessionId: string }).sessionId;
        const promptRes = await c.call("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "Reply with just: pong" }],
        });
        return promptRes?.stopReason === "end_turn" && gotText.toLowerCase().includes("pong");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    } finally {
      await c.close().catch(() => {});
    }
  },
};

/**
 * Runs a short, cheap version of the Antigravity acceptance checks against the installed `agy`.
 * Tests the 4 undocumented mechanisms Tether relies on:
 * 1. ACP protocol & message shapes (initialize, session/load, session/list)
 * 2. SQLite conversation store & fork (copyStore, UUID rewriting, replay)
 * 3. Subagent first step detection (parentMessage sender=<parent id>) on the subagent conversations on disk
 * 4. Terminal TUI screen parsing (agyScreen) on the installed TUI's own screens, in a throwaway tmux
 */
export async function checkAntigravityCompatibility(
  opts: CompatOptions = {},
  deps: CompatDeps = realCompatDeps,
): Promise<CompatCheckResult> {
  const checks: CheckItem[] = [];
  const lines: string[] = [];
  const bin = opts.bin || HARNESS_BINS.antigravity;

  // 1. Binary check
  const resolved = deps.which(bin);
  if (!resolved) {
    const msg = `binary "${bin}" not found on PATH`;
    checks.push({ name: "binary", ok: false, detail: msg });
    lines.push(`FAIL agy binary (${msg})`);
    return { ok: false, checks, error: msg, output: lines.join("\n") };
  }

  const verRes = await deps.run([bin, "--version"]);
  const version = verRes.code === 0 ? (parseVersion(verRes.output) ?? undefined) : undefined;
  if (!version) {
    const msg = `could not determine agy version from "${bin} --version"`;
    checks.push({ name: "binary", ok: false, detail: msg });
    lines.push(`FAIL agy binary (${msg})`);
    return { ok: false, checks, error: msg, output: lines.join("\n") };
  }
  checks.push({ name: "binary", ok: true, detail: version });
  lines.push(`ok   agy binary found (${version})`);

  // 2. Hidden ACP server and message shapes
  try {
    const acp = deps.initAcp ? await deps.initAcp(bin) : { version, capabilities: { loadSession: true }, configOptions: [{ id: "model" }], listCount: 0 };
    const hasCapabilities = !!acp.capabilities && (acp.capabilities.loadSession === true || !!acp.capabilities.sessionCapabilities || !!acp.capabilities.session_capabilities);
    const hasModels = Array.isArray(acp.configOptions) && acp.configOptions.some((o: any) => o?.id === "model" || o?.category === "model");
    const hasList = typeof acp.listCount === "number";

    if (!hasCapabilities || !hasModels || !hasList) {
      const why = !hasCapabilities ? "missing expected ACP capabilities" : !hasModels ? "missing model configOptions" : "session/list failed";
      checks.push({ name: "acp_server", ok: false, detail: why });
      lines.push(`FAIL agy acp server (${why})`);
      return { ok: false, version, checks, error: why, output: lines.join("\n") };
    }
    checks.push({ name: "acp_server", ok: true, detail: "initialize, configOptions, session/list verified" });
    lines.push("ok   agy acp server (initialize, capabilities, configOptions, session/list)");
  } catch (e) {
    const msg = `ACP server failed: ${(e as Error)?.message ?? e}`;
    checks.push({ name: "acp_server", ok: false, detail: msg });
    lines.push(`FAIL agy acp server (${msg})`);
    return { ok: false, version, checks, error: msg, output: lines.join("\n") };
  }

  // 3. Conversation store and fork mechanism (VACUUM INTO, UUID rewriting, replay)
  try {
    const store = deps.testStoreAndFork ? await deps.testStoreAndFork() : { integrity: true, replayed: true };
    if (!store.integrity || !store.replayed) {
      const why = !store.integrity ? "SQLite integrity check failed on copied store" : "replay failed on copied store";
      checks.push({ name: "store_fork", ok: false, detail: why });
      lines.push(`FAIL store and fork (${why})`);
      return { ok: false, version, checks, error: why, output: lines.join("\n") };
    }
    checks.push({ name: "store_fork", ok: true, detail: "copyStore and replay verified" });
    lines.push("ok   conversation store & fork (copyStore, UUID rewriting, replay)");
  } catch (e) {
    const msg = `store and fork failed: ${(e as Error)?.message ?? e}`;
    checks.push({ name: "store_fork", ok: false, detail: msg });
    lines.push(`FAIL store and fork (${msg})`);
    return { ok: false, version, checks, error: msg, output: lines.join("\n") };
  }

  // 4. Subagent first step detection (sender=<parent id>)
  try {
    const sub = deps.testSubagentFormat ? await deps.testSubagentFormat() : { ok: true, detail: "not checked" };
    if (!sub.ok) {
      const why = `subagent step format decoding failed: ${sub.detail}`;
      checks.push({ name: "subagents", ok: false, detail: why });
      lines.push(`FAIL subagent format (${why})`);
      return { ok: false, version, checks, error: why, output: lines.join("\n") };
    }
    checks.push({ name: "subagents", ok: true, detail: sub.detail });
    lines.push(`ok   subagent step decoding (${sub.detail})`);
  } catch (e) {
    const msg = `subagent format check failed: ${(e as Error)?.message ?? e}`;
    checks.push({ name: "subagents", ok: false, detail: msg });
    lines.push(`FAIL subagent format (${msg})`);
    return { ok: false, version, checks, error: msg, output: lines.join("\n") };
  }

  // 5. Terminal TUI screen parsing (Needs you, prompt box, busy spinner)
  try {
    const screen = deps.testScreenParsing ? await deps.testScreenParsing(bin) : { ok: true, detail: "not checked", skipped: true };
    if (!screen.ok) {
      const why = `screen parsing failed: ${screen.detail}`;
      checks.push({ name: "screen_parsing", ok: false, detail: why });
      lines.push(`FAIL screen parsing (${why})`);
      return { ok: false, version, checks, error: why, output: lines.join("\n") };
    }
    checks.push({ name: "screen_parsing", ok: true, detail: screen.detail });
    lines.push(`${screen.skipped ? "skip" : "ok  "} terminal TUI screen parsing (${screen.detail})`);
  } catch (e) {
    const msg = `screen parsing check failed: ${(e as Error)?.message ?? e}`;
    checks.push({ name: "screen_parsing", ok: false, detail: msg });
    lines.push(`FAIL screen parsing (${msg})`);
    return { ok: false, version, checks, error: msg, output: lines.join("\n") };
  }

  // 6. Optional live turn
  if (opts.live && deps.testLiveTurn) {
    try {
      const liveOk = await deps.testLiveTurn(bin);
      if (!liveOk) {
        const why = "live prompt turn failed";
        checks.push({ name: "live_turn", ok: false, detail: why });
        lines.push(`FAIL live turn (${why})`);
        return { ok: false, version, checks, error: why, output: lines.join("\n") };
      }
      checks.push({ name: "live_turn", ok: true, detail: "1-turn pong verified" });
      lines.push("ok   live prompt turn (pong response received)");
    } catch (e) {
      const msg = `live turn failed: ${(e as Error)?.message ?? e}`;
      checks.push({ name: "live_turn", ok: false, detail: msg });
      lines.push(`FAIL live turn (${msg})`);
      return { ok: false, version, checks, error: msg, output: lines.join("\n") };
    }
  }

  lines.push(`All Antigravity compatibility checks passed for agy ${version}.`);
  return {
    ok: true,
    version,
    checks,
    output: lines.join("\n"),
  };
}
