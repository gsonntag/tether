// The service the UI talks to, plus session injection and the MCP server, in a scratch home.

import "./testenv";
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextEvent } from "../../../web/src/shared/protocol";
import { CONFIG_DIR, config, migrateJudge, normalizeModelEntry } from "../config";
import { isContextTool, rules } from "../guard";
import { put, seedHome } from "./fixtures";
import { ContextService } from "./index";
import { acpMcpServers, sessionContext, setInjectionEnabled, withPreamble } from "./inject";
import { handle } from "./mcp";
import type { Decider } from "./merge";
import { harness } from "./paths";
import { inboxEntries } from "./sources";

// Never let these tests write a real runner.json.
if (!CONFIG_DIR.startsWith(tmpdir())) throw new Error(`refusing to run: runner config dir ${CONFIG_DIR} is not a temp dir`);

let repo: string;
let events: ContextEvent[];

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

function service(decider: Decider = async () => ({ action: "new" })) {
  events = [];
  return new ContextService({ emit: (e) => events.push(e), decider, sessionForKey: (k) => (k === "key1" ? "claude-code:s1" : undefined) });
}

beforeEach(() => {
  ({ repo } = seedHome());
  config().context = undefined;
  config().backgroundModel = undefined;
  setInjectionEnabled(false);
});

describe("context service", () => {
  test("off by default: no injection, edits refused, nothing written to the home", async () => {
    const s = service();
    s.start();
    expect(s.status().enabled).toBe(false);
    expect(await sessionContext(repo)).toBeUndefined();
    expect(existsSync(join(process.env.HOME!, ".config", "tether", "context"))).toBe(false);
    expect(readFileSync(harness.claudeMd(), "utf8")).not.toContain("tether:begin");
  });

  test("preview is a dry run listing memories, skill backups/links and managed files", async () => {
    put(join(harness.claudeSkills(), "grill", "SKILL.md"), "---\nname: grill\n---\nx\n");
    const before = readFileSync(harness.claudeMd(), "utf8");
    const p = await service().preview();
    expect(p.memories.map((m) => m.title)).toContain("former AWS KMS intern; strong on auth");
    expect(p.backups.map((b) => b.path)).toEqual(["~/.claude/skills/grill"]);
    expect(p.symlinks.map((l) => l.path)).toContain("~/.claude/skills/grill");
    expect(p.managedFiles).toContain("~/.claude/CLAUDE.md");
    expect(p.mcpConfigs).toContain("~/.codex/config.toml");
    // Touched nothing.
    expect(readFileSync(harness.claudeMd(), "utf8")).toBe(before);
    expect(readdirSync(harness.claudeSkills())).toEqual(["grill"]);
    expect(existsSync(join(process.env.HOME!, ".config", "tether", "context"))).toBe(false);
  });

  test("import: enables the feature, imports, exports, and injects into sessions", async () => {
    const s = service();
    const st = await s.runImport();
    expect(st.enabled).toBe(true);
    expect(config().context?.enabled).toBe(true);
    await until(() => events.some((e) => e.type === "status" && !e.status.busy && e.status.memories > 0));
    await until(() => readFileSync(harness.claudeMd(), "utf8").includes("tether:begin"));
    expect((await s.listMemories("global")).map((m) => m.name)).toContain("user-background");
    expect((await s.listMemories(repo)).map((m) => m.name)).toEqual(["deploy-flow"]);
    expect((await s.listMemories(undefined, "deploy")).map((m) => m.name)).toContain("deploy-flow");
    expect(s.activity().some((a) => a.kind === "new")).toBe(true);
    const ctx = (await sessionContext(repo, { id: "claude-code:x", key: "k" }))!;
    expect(ctx.prompt).toContain("user-background");
    expect(ctx.prompt).toContain("fol deploy");
    expect(ctx.mcp.env).toMatchObject({ TETHER_SESSION_ID: "claude-code:x", TETHER_SESSION_KEY: "k" });
    expect(acpMcpServers(ctx)[0]).toMatchObject({ name: "tether-context", env: expect.arrayContaining([{ name: "TETHER_SESSION_KEY", value: "k" }]) });
    expect(withPreamble("P", "hi")).toBe("P\n\nhi");
    s.stop();
  });

  test("edit, history, and conflicts: keep old restores the earlier version", async () => {
    const s = service(async (_e, cands) => ({ action: "contradicts", id: cands[0]!.id, body: "Use npm.", oldClaim: "bun", newClaim: "npm" }));
    await s.runImport();
    await until(() => events.some((e) => e.type === "status" && !e.status.busy && e.status.memories > 0));
    const tooling = (await s.listMemories("global")).find((m) => m.name === "tooling")!;
    const edited = (await s.editMemory(tooling.id, { body: "Prefer bun over npm for every script." })) as any;
    expect(edited.body).toBe("Prefer bun over npm for every script.");
    expect((await s.history(tooling.id)).map((h) => h.message)).toEqual([`memory: edit ${tooling.id} (by you)`, `memory: add ${tooling.id}`]);
    // An MCP write from a live session contradicts it.
    put(join(s.store.dir, "inbox", "1.json"), JSON.stringify({ text: "Prefer npm over bun for scripts.", scope: "global", sessionKey: "key1" }));
    await s.sync();
    const [c] = s.conflicts();
    expect(c).toMatchObject({ memoryId: tooling.id, sessionId: "claude-code:s1", status: "open" });
    expect(s.getMemory(tooling.id).body).toBe("Use npm.");
    expect(events.some((e) => e.type === "conflict" && e.conflict.id === c!.id)).toBe(true);
    const r = await s.resolveConflict(c!.id, "keep-old");
    expect(r.status).toBe("kept-old");
    expect(s.getMemory(tooling.id).body).toBe("Prefer bun over npm for every script.");
    expect(s.conflicts()).toEqual([]);
    expect(s.conflicts("all")[0]!.status).toBe("kept-old");
    // Delete.
    await s.editMemory(tooling.id, { remove: true });
    expect(() => s.getMemory(tooling.id)).toThrow();
    s.stop();
  });

  test("background model: one normalized 'harness:model'; the judge is a separate on/off", () => {
    config().guard = undefined;
    const s = service();
    expect(s.backgroundModel()).toMatchObject({ model: "claude-code:haiku", judge: true });
    s.setBackgroundModel("codex:gpt-5-mini");
    expect(s.backgroundModel().model).toBe("codex:gpt-5-mini");
    s.setBackgroundModel("sonnet"); // bare: a Claude model
    expect(config().backgroundModel).toBe("claude-code:sonnet");
    expect(config().guard?.judgeModel).toBeUndefined(); // no second copy of the model any more
    expect(() => s.setBackgroundModel("kiro:x")).toThrow();
    expect(() => s.setBackgroundModel("off")).toThrow();
    s.setJudgeEnabled(false);
    expect(s.backgroundModel()).toMatchObject({ model: "claude-code:sonnet", judge: false });
    expect(config().guard).toMatchObject({ judge: false, judgeModel: "off" }); // older runners see "off"
    s.setJudgeEnabled(true);
    expect(s.backgroundModel().judge).toBe(true);
    expect(config().guard?.judgeModel).toBeUndefined();
  });

  test("old judge settings migrate; doubled prefixes are repaired", () => {
    expect(normalizeModelEntry("haiku")).toBe("claude-code:haiku");
    expect(normalizeModelEntry("claude-code:codex:gpt-5-mini")).toBe("codex:gpt-5-mini");
    expect(normalizeModelEntry("claude-code:claude-code:opus")).toBe("claude-code:opus");
    expect(normalizeModelEntry("pi:openai-codex/gpt-6-luna")).toBe("pi:openai-codex/gpt-6-luna");
    expect(normalizeModelEntry("off")).toBeUndefined();
    const cases: [any, any, string | undefined, boolean][] = [
      // guard, backgroundModel → expected backgroundModel, judge on
      [{ judgeModel: "sonnet" }, undefined, "claude-code:sonnet", true],
      [{ judgeModel: "codex:gpt-5-mini" }, undefined, "codex:gpt-5-mini", true],
      [{ judgeModel: "haiku" }, "pi:x/y", "pi:x/y", true], // an explicit background model wins
      [{ judgeModel: "off" }, "claude-code:codex:gpt-5-mini", "codex:gpt-5-mini", false],
      [undefined, "claude-code:codex:m", "codex:m", true],
    ];
    for (const [guard, bg, want, judge] of cases) {
      const cfg: any = { guard: guard && { ...guard }, backgroundModel: bg };
      migrateJudge(cfg);
      expect(cfg.backgroundModel).toBe(want);
      expect(cfg.guard?.judge !== false).toBe(judge);
      expect(cfg.guard?.judgeModel === undefined || cfg.guard.judgeModel === "off").toBe(true);
      const again = JSON.stringify(cfg);
      expect(migrateJudge(cfg)).toBe(false); // idempotent
      expect(JSON.stringify(cfg)).toBe(again);
    }
  });
});

describe("guard", () => {
  test("tether-context MCP tools are always allowed, in every harness's naming", () => {
    for (const tool of ["mcp__tether-context__memory_write", "tether-context_memory_search", "tether_context_skill_get"])
      expect(rules({ tool, input: {}, cwd: "/x" })?.decision).toBe("allow");
    expect(isContextTool("mcp", { tool: "tether_context_memory_write", args: {} })).toBe(true);
    expect(isContextTool("mcp", { action: "install", url: "x" })).toBe(false);
    expect(rules({ tool: "mcp__other__x", input: {}, cwd: "/x" })).toBeUndefined();
  });
});

describe("MCP server", () => {
  test("initialize, list and call over JSON-RPC", async () => {
    const s = service();
    await s.runImport();
    await until(() => events.some((e) => e.type === "status" && !e.status.busy && e.status.memories > 0));
    const init: any = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    expect(init.result.serverInfo.name).toBe("tether-context");
    expect(init.result.protocolVersion).toBe("2025-03-26");
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    const list: any = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.result.tools.map((t: any) => t.name)).toEqual(["memory_search", "memory_get", "memory_write", "skill_list", "skill_get"]);
    const call = async (name: string, args: object) => ((await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } })) as any).result;
    const prev = process.cwd();
    process.chdir(repo);
    try {
      expect((await call("memory_search", { query: "deploy" })).content[0].text).toContain("deploy-flow");
      expect((await call("memory_get", { slug: "user-background" })).content[0].text).toContain("Cognito");
      expect((await call("memory_get", { slug: "nope" })).isError).toBe(true);
      process.env.TETHER_SESSION_ID = "pi:s9";
      expect((await call("memory_write", { text: "The CI runs on Fridays.", scope: "repo", type: "project" })).isError).toBeUndefined();
      delete process.env.TETHER_SESSION_ID;
      const [w] = inboxEntries(join(s.store.dir, "inbox"));
      expect(w).toMatchObject({ text: "The CI runs on Fridays.", sessionId: "pi:s9", scope: `repo:${repo}`, memory: { type: "project" } });
      expect((await call("skill_list", {})).content[0].text).toBe("The skill library is empty.");
    } finally {
      process.chdir(prev);
    }
    const bad: any = await handle({ jsonrpc: "2.0", id: 4, method: "nope" });
    expect(bad.error.code).toBe(-32601);
    s.stop();
  });

  test("stdio entrypoint answers a real handshake", async () => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "mcp.ts")], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env } });
    const sink = p.stdin as import("bun").FileSink;
    sink.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    sink.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    await sink.end();
    const lines = (await new Response(p.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.id)).toEqual([1, 2]);
    expect(lines[1].result.tools.length).toBe(5);
  });
});

/** Everything under HOME except the store/config: path → content, link target or "dir". */
function snapshot(root = process.env.HOME!): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (p === join(root, ".config", "tether")) continue;
      const st = lstatSync(p);
      const rel = p.slice(root.length);
      if (st.isSymbolicLink()) out[rel] = `link:${readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[rel] = "dir";
        walk(p);
      } else out[rel] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

function seedSkillsAndConfigs() {
  const skill = (dir: string, name: string, body: string) => put(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`);
  skill(harness.claudeSkills(), "grill", "claude copy");
  skill(harness.codexSkills(), "grill", "claude copy");
  skill(harness.codexSkills(), "codex-only", "only in codex");
  put(join(harness.claudeSkills(), "synced", "abc", "SKILL.md"), "claude.ai owned");
  skill(join(harness.codexSkills(), ".system"), "skill-creator", "builtin");
  put(harness.codexConfig(), 'model = "gpt"\n\n[profiles.x]\nmodel = "y"\n');
  put(harness.agyMcp(), ""); // exists, empty (as on the real machine)
  put(harness.piAgentsMd(), "# pi rules\n\nbe brief"); // no final newline
}

describe("progress and turning off", () => {
  test("import reports progress: phases with done/total, merge counts every entry", async () => {
    const s = service();
    await s.runImport();
    await s.idle();
    const progress = events.flatMap((e) => (e.type === "status" && e.status.progress ? [e.status.progress] : []));
    const merge = progress.filter((p) => p.phase === "merge");
    expect(merge.length).toBeGreaterThan(0);
    expect(merge[merge.length - 1]!.done).toBe(merge[merge.length - 1]!.total);
    expect(merge[merge.length - 1]!.total).toBeGreaterThan(1);
    expect(progress.some((p) => p.phase === "export")).toBe(true);
    expect(s.status().progress).toBeUndefined(); // cleared when done
    expect(s.status().busy).toBe(false);
    s.stop();
  });

  test("a second Import click while one runs doesn't start another", async () => {
    const s = service();
    await s.runImport();
    await s.runImport();
    await s.idle();
    expect(s.activity().filter((a) => a.text === "Import started").length).toBe(1);
    s.stop();
  });

  test("turning the feature off restores every harness file and skill dir", async () => {
    seedSkillsAndConfigs();
    const before = snapshot();
    const s = service();
    await s.runImport();
    await s.idle();
    // Imported and exported: links in place, blocks written.
    expect(lstatSync(join(harness.claudeSkills(), "grill")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(harness.codexSkills(), "codex-only")).isSymbolicLink()).toBe(true);
    expect(readFileSync(harness.piAgentsMd(), "utf8")).toContain("tether:begin");
    expect(readFileSync(harness.codexConfig(), "utf8")).toContain("tether-context");
    // Idempotent: another pass changes nothing in the home.
    const mid = snapshot();
    await s.sync({ forceExport: true });
    expect(snapshot()).toEqual(mid);

    await s.disable();
    expect(s.status().enabled).toBe(false);
    const after = snapshot();
    // Every file the user had is back byte for byte; replaced skills are real copies again.
    for (const [p, v] of Object.entries(before)) expect([p, after[p]]).toEqual([p, v]);
    // Nothing left behind but empty dirs Tether made for install links.
    const extra = Object.keys(after).filter((p) => !(p in before));
    expect(extra.filter((p) => after[p] !== "dir")).toEqual([]);
    // The store and the backups survive.
    expect(existsSync(join(s.store.dir, "backup"))).toBe(true);
    expect(s.listSkills().map((x) => x.name)).toContain("grill");
    s.stop();
  });

  test("disabling then enabling a skill puts back links in dirs that only had a copy (codex)", async () => {
    seedSkillsAndConfigs();
    const s = service();
    await s.runImport();
    await s.idle();
    const codexLink = join(harness.codexSkills(), "codex-only");
    expect(lstatSync(codexLink).isSymbolicLink()).toBe(true);
    await s.setSkillEnabled("codex-only", false);
    expect(existsSync(codexLink)).toBe(false);
    await s.setSkillEnabled("codex-only", true);
    expect(lstatSync(codexLink).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(codexLink, "SKILL.md"), "utf8")).toContain("only in codex");
    s.stop();
  });
});
