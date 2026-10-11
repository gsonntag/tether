// What each connector adds to a session launch, its skill syntax and dirs, the capability matrix,
// and that the export and skill install still run in the order they did before connectors.

import { resetHome } from "../testenv";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES, type HarnessId } from "../../../web/src/shared/protocol";
import { put } from "../context/fixtures";
import { exportAll } from "../context/export";
import type { SessionContext } from "../context/inject";
import { configDir, harness, tilde } from "../context/paths";
import { skillDirs } from "../context/skills";
import { Store } from "../context/store";
import { capabilityMatrix, connectorFor } from "./index";
import { launchWith } from "./launch";
import { goalFilterFrom, isGoalExtension, piGoalFilter, piHasGoalExtension } from "./pi";
import { mergeLaunch } from "./shared";
import { SLOTS } from "./types";

const ctx: SessionContext & { prompt: string } = { prompt: "<tether-memory>M</tether-memory>", mcp: { command: "/bun", args: ["/mcp.ts"], env: { TETHER_CONTEXT_DIR: "/ctx", TETHER_SESSION_KEY: "gk" } } };
const at = (h: HarnessId, extra: { resume?: boolean; context?: SessionContext } = {}) =>
  launchWith(h, { projectPath: "/p", session: { key: "gk" }, context: "context" in extra ? extra.context : ctx, resume: extra.resume });

beforeEach(() => resetHome());

describe("session launch per harness", () => {
  test("Claude Code: system prompt append and an SDK stdio server", () => {
    expect(at("claude-code")).toEqual({
      args: [],
      env: {},
      options: {
        systemPrompt: { type: "preset", preset: "claude_code", append: ctx.prompt },
        mcpServers: { "tether-context": { type: "stdio", command: "/bun", args: ["/mcp.ts"], env: ctx.mcp.env } },
      },
    });
  });

  test("Codex: developer instructions and a thread config override", () => {
    expect(at("codex")).toEqual({
      args: [],
      env: {},
      options: {
        developerInstructions: ctx.prompt,
        config: { "mcp_servers.tether-context": { command: "/bun", args: ["/mcp.ts"], env: ctx.mcp.env, default_tools_approval_mode: "approve" } },
      },
    });
  });

  test("pi: --append-system-prompt, then --mcp-config only with pi-mcp-adapter", () => {
    expect(at("pi")).toEqual({ args: ["--append-system-prompt", ctx.prompt], options: {}, env: {} });
    put(harness.piSettings(), JSON.stringify({ packages: ["npm:pi-mcp-adapter"] }));
    const l = at("pi");
    expect(l.args.slice(0, 3)).toEqual(["--append-system-prompt", ctx.prompt, "--mcp-config"]);
    expect(l.args[3]!.startsWith(join(configDir(), "run", "pi-mcp-"))).toBe(true);
    expect(JSON.parse(readFileSync(l.args[3]!, "utf8")).mcpServers["tether-context"]).toEqual({ command: "/bun", args: ["/mcp.ts"], env: ctx.mcp.env });
  });

  for (const h of ["opencode", "kiro"] as const)
    test(`${h}: ACP mcpServers, and a preamble for new sessions only`, () => {
      const servers = [{ name: "tether-context", command: "/bun", args: ["/mcp.ts"], env: [{ name: "TETHER_CONTEXT_DIR", value: "/ctx" }, { name: "TETHER_SESSION_KEY", value: "gk" }] }];
      expect(at(h)).toEqual({ args: [], env: {}, options: { mcpServers: servers }, preamble: ctx.prompt });
      expect(at(h, { resume: true })).toEqual({ args: [], env: {}, options: { mcpServers: servers } });
    });

  test("Antigravity: a preamble and nothing per session for MCP", () => {
    expect(at("antigravity")).toEqual({ args: [], env: {}, options: {}, preamble: ctx.prompt });
  });

  test("master context off: nothing added (ACP still sends an empty mcpServers)", () => {
    for (const { id } of HARNESSES) {
      const l = at(id, { context: undefined });
      expect(l.args).toEqual([]);
      expect(l.preamble).toBeUndefined();
      expect(l.options).toEqual(id === "opencode" || id === "kiro" ? { mcpServers: [] } : {});
    }
  });

  test("mergeLaunch: args in order, nested options merged, preambles joined", () => {
    expect(mergeLaunch([{ args: ["a"], options: { config: { x: 1 } }, preamble: "P" }, undefined, { args: ["b"], options: { config: { y: 2 } }, env: { E: "1" }, preamble: "Q" }])).toEqual({
      args: ["a", "b"],
      options: { config: { x: 1, y: 2 } },
      env: { E: "1" },
      preamble: "P\n\nQ",
    });
  });
});

describe("skills", () => {
  test("each harness's invocation syntax", () => {
    const inv = Object.fromEntries(HARNESSES.map(({ id }) => [id, connectorFor(id).skills.invoke("grill", "me")]));
    expect(inv).toEqual({ "claude-code": "/grill me", codex: "/grill me", pi: "/skill:grill me", opencode: "/grill me", kiro: "/grill me", antigravity: "/grill me" });
    expect(connectorFor("pi").skills.invoke("grill", "")).toBe("/skill:grill");
  });

  test("offline native runs: Claude Code, Codex and pi only", () => {
    expect(HARNESSES.filter(({ id }) => connectorFor(id).skills.offline).map((h) => h.id)).toEqual(["claude-code", "codex", "pi"]);
  });

  test("session skill dirs per harness", () => {
    const repo = join(process.env.HOME!, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const dirs = (h: HarnessId) => connectorFor(h).skills.dirs(repo).map((d) => `${d.source}:${tilde(d.dir)}`);
    expect(dirs("claude-code")).toEqual(["repo:~/repo/.claude/skills", "claude:~/.claude/skills"]);
    expect(dirs("codex")).toEqual(["repo:~/repo/.agents/skills", "repo:~/repo/.codex/skills", "codex:~/.codex/skills", "agents:~/.agents/skills"]);
    expect(dirs("pi")).toEqual(["repo:~/repo/.pi/skills", "repo:~/repo/.agents/skills", "pi:~/.pi/agent/skills", "agents:~/.agents/skills"]);
    expect(dirs("opencode")).toEqual([
      "repo:~/repo/.opencode/skills",
      "repo:~/repo/.claude/skills",
      "repo:~/repo/.agents/skills",
      "opencode:~/.config/opencode/skills",
      "claude:~/.claude/skills",
      "agents:~/.agents/skills",
    ]);
    expect(dirs("kiro")).toEqual(["repo:~/repo/.kiro/skills", "kiro:~/.kiro/skills"]);
    expect(dirs("antigravity")).toEqual(["antigravity:~/.gemini/antigravity/skills", "gemini:~/.gemini/skills"]);
  });

  test("install dirs keep their order; Kiro's only once ~/.kiro exists", () => {
    const list = () => skillDirs().map((d) => `${d.harness}${d.install ? "+" : ""}`);
    expect(list()).toEqual(["claude+", "agents+", "antigravity+", "gemini+", "kiro", "codex", "pi", "opencode"]);
    mkdirSync(harness.kiroDir(), { recursive: true });
    expect(list()).toContain("kiro+");
  });
});

describe("capability matrix", () => {
  test("every harness has every slot, with a level and a note", () => {
    const m = capabilityMatrix();
    expect(Object.keys(m).sort()).toEqual(HARNESSES.map((h) => h.id).sort());
    for (const row of Object.values(m)) {
      expect(Object.keys(row)).toEqual(SLOTS);
      for (const c of Object.values(row)) {
        expect(["native", "emulated", "unsupported"]).toContain(c.level);
        expect(c.note.length).toBeGreaterThan(0);
      }
    }
    expect(m.antigravity.skills.level).toBe("emulated");
    expect(m.opencode.memory.level).toBe("emulated");
    expect(m["claude-code"].memory.level).toBe("native");
  });
});

describe("global export order", () => {
  test("a dry run lists files in the order it always has", async () => {
    const h = process.env.HOME!;
    for (const d of [".claude", ".gemini/antigravity", ".codex", ".pi/agent", ".config/opencode", ".kiro/settings"]) mkdirSync(join(h, d), { recursive: true });
    const store = new Store(join(configDir(), "context"));
    await store.init();
    const out = await exportAll(store, { dryRun: true, globalMcp: true });
    expect(out.written.map(tilde)).toEqual([
      "~/.claude/CLAUDE.md",
      "~/.gemini/GEMINI.md",
      "~/.codex/AGENTS.md",
      "~/.pi/agent/AGENTS.md",
      "~/.config/opencode/AGENTS.md",
      "~/.kiro/steering/tether.md",
      "~/.codex/config.toml",
      "~/.pi/agent/mcp.json",
      "~/.kiro/settings/mcp.json",
      "~/.gemini/config/mcp_config.json",
      "~/.claude.json",
      "~/.config/opencode/opencode.json",
    ]);
    expect(out.mcpConfigs.map(tilde)).toEqual([
      "~/.codex/config.toml",
      "~/.pi/agent/mcp.json",
      "~/.kiro/settings/mcp.json",
      "~/.gemini/config/mcp_config.json",
      "~/.claude.json",
      "~/.config/opencode/opencode.json",
    ]);
    // Without the user's import, the configs Claude Code and opencode keep writing aren't touched.
    expect((await exportAll(store, { dryRun: true })).mcpConfigs.map(tilde)).not.toContain("~/.claude.json");
  });
});

describe("pi's own goal extension stays out of Tether sessions", () => {
  test("goal packages and extension files by name; nothing else", () => {
    for (const s of ["npm:pi-goal-x", "npm:pi-goal", "npm:@me/pi-goals", "git:github.com/x/pi-goal-x@v1", "/home/u/.pi/agent/extensions/goal.ts", "goal"]) expect(isGoalExtension(s)).toBe(true);
    for (const s of ["npm:pi-subagents", "npm:goalkeeper", "npm:@narumitw/pi-usage", "/x/goalie.ts", "builtin:mcp"]) expect(isGoalExtension(s)).toBe(false);
  });

  test("every other enabled extension by path, built-ins included, after --no-extensions", () => {
    const f = goalFilterFrom([
      { path: "/n/pi-subagents/index.js", enabled: true, source: "npm:pi-subagents" },
      { path: "/n/pi-goal-x/extensions/goal.ts", enabled: true, source: "npm:pi-goal-x" },
      { path: "/n/pi-x/extensions/goal.ts", enabled: true, source: "npm:pi-x" }, // a package's own file named goal: its package decides
      { path: "/h/.pi/agent/extensions/goal.ts", enabled: true, source: "auto" },
      { path: "/h/.pi/agent/extensions/limits.ts", enabled: true, source: "auto" },
      { path: "builtin:codemode", enabled: true, source: "builtin" },
      { path: "builtin:mcp", enabled: false, source: "builtin" },
    ]);
    expect(f).toEqual({
      args: ["--no-extensions", "-e", "/n/pi-subagents/index.js", "-e", "/n/pi-x/extensions/goal.ts", "-e", "/h/.pi/agent/extensions/limits.ts", "-e", "builtin:codemode"],
      excluded: ["npm:pi-goal-x", "auto"],
    });
    // No goal extension loaded: pi launches as it always did.
    expect(goalFilterFrom([{ path: "/n/a.js", enabled: true, source: "npm:a" }]).args).toEqual([]);
  });

  test("only when the user's pi setup has one, and not in a project with pi resources of its own", async () => {
    const proj = join(process.env.HOME!, "proj");
    mkdirSync(proj, { recursive: true });
    put(harness.piSettings(), JSON.stringify({ packages: ["npm:pi-mcp-adapter"] }));
    expect(piHasGoalExtension()).toBe(false);
    expect(await piGoalFilter(proj)).toEqual({ args: [], excluded: [], why: "no goal extension" });
    put(harness.piSettings(), JSON.stringify({ packages: ["npm:pi-mcp-adapter", "npm:pi-goal-x"] }));
    expect(piHasGoalExtension()).toBe(true);
    expect(connectorFor("pi").goal.capability().note).toContain("pi's own goal extension is left out");
    put(join(proj, ".pi", "settings.json"), "{}");
    expect((await piGoalFilter(proj)).args).toEqual([]);
  });
});
