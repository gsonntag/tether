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
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AcpClient } from "../acp/client";
import { HARNESS_BINS, parseVersion } from "../detect";
import { copyStore, discardStore } from "./fork";
import { agyScreen } from "./screen";
import { acpArgv, conversationFile, reader } from "./store";
import { childInfo, parentMessage } from "./subagents";
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
  testSubagentFormat?: () => Promise<boolean>;
  testScreenParsing?: () => boolean;
  testLiveTurn?: (bin: string) => Promise<boolean>;
}

export const realCompatDeps: CompatDeps = {
  which: (bin) => (bin.includes("/") ? (existsSync(bin) ? bin : null) : Bun.which(bin)),
  run: (argv, opts) => runCommand(argv, { timeoutMs: opts?.timeoutMs ?? 15_000, env: opts?.env }),
  async initAcp(bin: string) {
    const csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN || randomUUID();
    const c = new AcpClient({
      argv: [bin, "acp"],
      cwd: homedir(),
      env: { ANTIGRAVITY_CSRF_TOKEN: csrfToken },
      name: "Antigravity",
      onUpdate: () => {},
    });
    try {
      await c.initialize();
      const version = c.agent?.version;
      const capabilities = c.agent?.capabilities;
      const loadRes = await c.call("session/load", { sessionId: "00000000-0000-4000-8000-000000000000", cwd: homedir(), mcpServers: [] });
      const listRes = await c.call("session/list", {});
      const listCount = Array.isArray(listRes?.sessions) ? listRes.sessions.length : undefined;
      return { version, capabilities, configOptions: loadRes?.configOptions, listCount };
    } finally {
      await c.close().catch(() => {});
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
    // 1. Synthetic protobuf payload with the message shape agy writes
    const sample = new Uint8Array(
      Buffer.from("\x12\x0a..$abc\x1a[Message] timestamp=2026-11-21T00:37:56Z sender=4afd15cc-2c80-4b26-adbc-60918bcdeee5 priority=MESSAGE_PRIORITY_HIGH content=Please run ls here.\x0a\x12more", "latin1"),
    );
    const parsed = parentMessage(sample);
    if (!parsed || parsed.parent !== "4afd15cc-2c80-4b26-adbc-60918bcdeee5" || parsed.prompt !== "Please run ls here.") {
      return false;
    }
    // 2. If real conversations exist on this machine, test childInfo on one
    const convDir = join(homedir(), ".gemini", "antigravity-cli", "conversations");
    if (existsSync(convDir)) {
      try {
        const dbs = readdirSync(convDir).filter((f) => f.endsWith(".db"));
        for (const db of dbs.slice(0, 50)) {
          const id = db.slice(0, -3);
          const info = childInfo(id);
          if (info) {
            // Found a real subagent on disk and successfully parsed its parent & prompt
            if (!info.parent || !info.prompt) return false;
            break;
          }
        }
      } catch {}
    }
    return true;
  },
  testScreenParsing() {
    const idleScreen = "────────────────────────\n>\n────────────────────────\n? for shortcuts";
    const busyScreen = "⠋ Working on task\n────────────────────────\n>\n────────────────────────\nesc to cancel";
    const permScreen = "Requesting permission for command\n1. Allow\n2. Deny\n↑/↓ Navigate";
    const trustScreen = "Do you want to trust this folder?\n1. Yes\n2. No\n↑/↓ Navigate";

    const sIdle = agyScreen(idleScreen);
    const sBusy = agyScreen(busyScreen);
    const sPerm = agyScreen(permScreen);
    const sTrust = agyScreen(trustScreen);

    return (
      sIdle.state === "idle" &&
      sIdle.prompt === "normal" &&
      sBusy.state === "busy" &&
      sPerm.state === "asking" &&
      sTrust.state === "asking"
    );
  },
  async testLiveTurn(bin: string) {
    const csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN || randomUUID();
    const c = new AcpClient({
      argv: [bin, "acp"],
      cwd: homedir(),
      env: { ANTIGRAVITY_CSRF_TOKEN: csrfToken },
      name: "Antigravity",
      onUpdate: () => {},
    });
    try {
      await c.initialize();
      const tmp = mkdtempSync(join(tmpdir(), "tether-agy-live-"));
      try {
        const { sessionId } = (await c.call("session/new", { cwd: tmp, mcpServers: [] })) as { sessionId: string };
        let gotText = "";
        c.onUpdate = (_sid, u) => {
          if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
            gotText += u.content.text;
          }
        };
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
 * 3. Subagent first step detection (parentMessage sender=<parent id>)
 * 4. Terminal TUI screen parsing (agyScreen)
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
    const subOk = deps.testSubagentFormat ? await deps.testSubagentFormat() : true;
    if (!subOk) {
      const why = "subagent step format decoding failed";
      checks.push({ name: "subagents", ok: false, detail: why });
      lines.push(`FAIL subagent format (${why})`);
      return { ok: false, version, checks, error: why, output: lines.join("\n") };
    }
    checks.push({ name: "subagents", ok: true, detail: "parentMessage sender decoding verified" });
    lines.push("ok   subagent step decoding (sender=<parent id>)");
  } catch (e) {
    const msg = `subagent format check failed: ${(e as Error)?.message ?? e}`;
    checks.push({ name: "subagents", ok: false, detail: msg });
    lines.push(`FAIL subagent format (${msg})`);
    return { ok: false, version, checks, error: msg, output: lines.join("\n") };
  }

  // 5. Terminal TUI screen parsing (Needs you, prompt box, busy spinner)
  try {
    const screenOk = deps.testScreenParsing ? deps.testScreenParsing() : true;
    if (!screenOk) {
      const why = "screen parsing failed for prompt, busy or permission";
      checks.push({ name: "screen_parsing", ok: false, detail: why });
      lines.push(`FAIL screen parsing (${why})`);
      return { ok: false, version, checks, error: why, output: lines.join("\n") };
    }
    checks.push({ name: "screen_parsing", ok: true, detail: "prompt, busy, permission, trust parsed" });
    lines.push("ok   terminal TUI screen parsing (prompt, busy, permission, trust)");
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
