// Importers, watermarks, the merge pass (with a stubbed model) and export, end to end in a
// scratch home.

import "./testenv";
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextEvent } from "../../../web/src/shared/protocol";
import { BEGIN } from "./blocks";
import { exportAll, globalDigest, isOwnWrite, ownWrites } from "./export";
import { claudeMemory, put, seedCodexDb, seedHome } from "./fixtures";
import { git } from "./git";
import { Merger, normalizeDecision, type Decider } from "./merge";
import { contextDir, harness } from "./paths";
import { inboxEntries, scanSources, sections } from "./sources";
import { Store } from "./store";
import { Watcher } from "./watch";

let store: Store;
let home: string;
let repo: string;

beforeEach(async () => {
  ({ home, repo } = seedHome());
  ownWrites.clear();
  store = new Store(contextDir());
  await store.init();
});

/** A decider that must not be called. */
const noModel: Decider = async () => {
  throw new Error("model called");
};

async function importAll(decider: Decider = noModel, events: ContextEvent[] = []) {
  const { entries } = await scanSources(store, { changedOnly: true });
  return new Merger(store, decider, (e) => events.push(e)).mergeAll(entries);
}

describe("importers", () => {
  test("read Claude auto-memory (MEMORY.md index skipped) and global files outside blocks", async () => {
    const { entries } = await scanSources(store);
    const byPath = (s: string) => entries.filter((e) => e.path.endsWith(s));
    expect(byPath("MEMORY.md")).toEqual([]);
    const bg = byPath("user-background.md")[0]!;
    expect(bg.scope).toBe("global"); // the home dir's project is global
    expect(bg.memory?.type).toBe("user");
    const deploy = byPath("deploy-flow.md")[0]!;
    expect(deploy.scope).toBe(`repo:${repo}`);
    expect(deploy.provenance).toBe(`claude:~/.claude/projects/${repo.replace(/[/.]/g, "-")}/memory/deploy-flow.md`);
    const claudeMd = byPath("CLAUDE.md");
    expect(claudeMd.map((e) => e.title)).toEqual(["Skills"]); // the empty top heading is dropped
    expect(byPath("AGENTS.md")[0]!.text).toContain("Prefer bun");
  });

  test("watermarks: only new or changed entries come back", async () => {
    await importAll();
    expect((await scanSources(store, { changedOnly: true })).entries).toEqual([]);
    const f = join(harness.claudeProjects(), repo.replace(/[/.]/g, "-"), "memory", "deploy-flow.md");
    writeFileSync(f, claudeMemory("deploy-flow", "deploys go through fol deploy", "project", "Deploy with `fol deploy --prod`."));
    const changed = (await scanSources(store, { changedOnly: true })).entries;
    expect(changed.map((e) => e.path)).toEqual([f]);
    // Whitespace-only edits don't count.
    await new Merger(store, noModel).mergeAll(changed);
    writeFileSync(f, readFileSync(f, "utf8") + "\n\n");
    expect((await scanSources(store, { changedOnly: true })).entries).toEqual([]);
  });

  test("Codex memories sqlite is read read-only and defensively", async () => {
    seedCodexDb([{ thread: "t1", raw: "User prefers terse commit messages.", summary: "commit style", at: 10 }]);
    const { entries, warnings } = await scanSources(store);
    const row = entries.find((e) => e.provenance === "codex:memories#t1")!;
    expect(row.text).toBe("User prefers terse commit messages.");
    expect(row.title).toBe("commit style");
    expect(warnings).toEqual([]);
    // A DB without the expected table is skipped, not an error.
    rmSync(harness.codexMemoriesDb());
    put(harness.codexMemoriesDb(), "not a database");
    const bad = await scanSources(store);
    expect(bad.entries.some((e) => e.harness === "codex" && e.path.endsWith(".sqlite"))).toBe(false);
  });

  test("Kiro steering is imported except Tether's own file", async () => {
    put(join(harness.kiroSteering(), "style.md"), "---\ninclusion: always\n---\n\n## Style\n\nTwo-space indent.\n");
    put(join(harness.kiroSteering(), "tether.md"), "---\ninclusion: always\n---\n\n## Mine\n\nnope\n");
    const { entries } = await scanSources(store);
    const kiro = entries.filter((e) => e.harness === "kiro");
    expect(kiro.map((e) => e.title)).toEqual(["Style"]);
  });

  test("markdown sections split at headings, skipping @imports and fenced headings", () => {
    const s = sections("intro\n\n# A\n\nbody a\n@~/x.md\n```\n# not a heading\n```\n## B\n\n## C\nc\n");
    expect(s.map((x) => x.title)).toEqual(["", "A", "C"]);
    expect(s[1]!.body).toContain("# not a heading");
    expect(s[1]!.body).not.toContain("@~/x.md");
  });
});

describe("merge pass", () => {
  test("first import: unrelated entries are added without calling the model, one commit each", async () => {
    const before = Number((await git(store.dir, ["rev-list", "--count", "HEAD"])).trim());
    const out = await importAll();
    expect(out.every((o) => o.decision === "new")).toBe(true);
    const after = Number((await git(store.dir, ["rev-list", "--count", "HEAD"])).trim());
    expect(after - before).toBe(out.length);
    const bg = store.list().find((m) => m.name === "user-background")!;
    expect(bg.id).toBe("global/user-background");
    expect(bg.type).toBe("user");
    expect(bg.sources[0]).toStartWith("claude:~/.claude/projects/");
    const deploy = store.list().find((m) => m.name === "deploy-flow")!;
    expect(deploy.scope).toBe(`repo:${repo}`);
    expect(deploy.id).toStartWith("repos/");
    expect(store.readActivity().filter((a) => a.kind === "new").length).toBe(out.length);
  });

  test("an identical entry from another harness is a duplicate: provenance added, no model", async () => {
    await importAll();
    put(join(home, ".pi", "agent", "AGENTS.md"), "## Tooling\n\nPrefer bun over npm for scripts.\n");
    const out = await importAll();
    expect(out.map((o) => o.decision)).toEqual(["duplicate"]);
    const m = store.get(out[0]!.memoryId!)!;
    expect(m.sources.some((s) => s.startsWith("pi:"))).toBe(true);
    expect(m.sources.some((s) => s.startsWith("codex:"))).toBe(true);
  });

  test("update: the model's rewritten body is applied and committed", async () => {
    await importAll();
    put(join(home, ".pi", "agent", "AGENTS.md"), "## Tooling\n\nPrefer bun over npm for scripts, and bunx over npx.\n");
    let seen: string[] = [];
    const out = await importAll(async (_e, cands) => {
      seen = cands.map((c) => c.id);
      return { action: "update", id: cands[0]!.id, body: "Prefer bun over npm, and bunx over npx." };
    });
    expect(out[0]!.decision).toBe("update");
    expect(seen.length).toBeGreaterThan(0);
    const m = store.get(out[0]!.memoryId!)!;
    expect(m.body).toBe("Prefer bun over npm, and bunx over npx.");
    expect((await store.history(m.id)).length).toBe(2);
  });

  test("contradicts: newest wins, both claims recorded, conflict event with the session id", async () => {
    await importAll();
    put(join(store.dir, "inbox", "1.json"), JSON.stringify({ text: "Use npm, not bun, for scripts.", scope: "global", sessionId: "claude-code:abc" }));
    const events: ContextEvent[] = [];
    const out = await importAll(async (_e, cands) => ({ action: "contradicts", id: cands[0]!.id, body: "Use npm for scripts.", oldClaim: "prefers bun", newClaim: "prefers npm" }), events);
    expect(out[0]!.decision).toBe("contradicts");
    const c = store.conflicts()[0]!;
    expect(c).toMatchObject({ status: "open", sessionId: "claude-code:abc", oldClaim: "prefers bun", newClaim: "prefers npm", newBody: "Use npm for scripts." });
    expect(c.oldBody).toContain("Prefer bun");
    expect(store.get(c.memoryId)!.body).toBe("Use npm for scripts.");
    expect(events.some((e) => e.type === "conflict" && e.conflict.id === c.id)).toBe(true);
    expect(existsSync(join(store.dir, "inbox", "1.json"))).toBe(false); // consumed
    // "Keep old" material: the file as it was before the conflict's commit.
    expect(await store.before(c.memoryId, c.commit!)).toContain("Prefer bun");
  });

  test("model failure keeps the entry instead of dropping it", async () => {
    await importAll();
    put(join(home, ".pi", "agent", "AGENTS.md"), "## Tooling\n\nPrefer bun over npm for most scripts.\n");
    const out = await importAll(async () => {
      throw new Error("quota");
    });
    expect(out[0]!.decision).toBe("new");
    expect(store.readActivity().some((a) => a.kind === "error" && a.text.includes("quota"))).toBe(true);
  });

  test("a model that is down is tried once per pass, not once per entry", async () => {
    await importAll();
    put(join(home, ".pi", "agent", "AGENTS.md"), "## Tooling\n\nPrefer bun over npm for most scripts.\n\n## More tooling\n\nPrefer bun over npm for all scripts here.\n");
    let calls = 0;
    const out = await importAll(async () => {
      calls++;
      throw new Error("down");
    });
    expect(out.map((o) => o.decision)).toEqual(["new", "new"]);
    expect(calls).toBe(1);
  });

  test("a source re-edited with nothing else overlapping updates its own entry without the model", async () => {
    await importAll();
    const f = join(harness.claudeProjects(), repo.replace(/[/.]/g, "-"), "memory", "deploy-flow.md");
    writeFileSync(f, claudeMemory("deploy-flow", "deploys go through fol deploy", "project", "Deploy with `fol deploy --prod` now."));
    const out = await importAll();
    expect(out.map((o) => o.decision)).toEqual(["update"]);
    expect(store.list().filter((m) => m.name.startsWith("deploy-flow")).length).toBe(1);
  });

  test("model replies are validated", () => {
    const cands = [{ id: "global/a" } as any];
    expect(normalizeDecision({ action: "update", id: "global/zzz", body: "x" }, cands, ["global"]).action).toBe("new");
    expect(normalizeDecision({ action: "update", id: "global/a" }, cands, ["global"]).action).toBe("new"); // no body
    expect(normalizeDecision({ action: "duplicate", id: "global/a" }, cands, ["global"])).toEqual({ action: "duplicate", id: "global/a" });
    expect(normalizeDecision({ action: "new", scope: "repo" }, [], ["global", "repo:k"])).toMatchObject({ action: "new", scope: "repo:k" });
    expect(normalizeDecision("garbage", [], ["global"]).action).toBe("new");
  });

  test("MCP inbox entries carry scope and session", () => {
    put(join(store.dir, "inbox", "9.json"), JSON.stringify({ text: "Fact", repo: "github.com/a/b", sessionKey: "k1" }));
    put(join(store.dir, "inbox", "bad.json"), "{");
    const [e] = inboxEntries(join(store.dir, "inbox"));
    expect(e).toMatchObject({ harness: "mcp", scope: undefined, repoHint: "github.com/a/b", sessionKey: "k1" });
  });
});

describe("export and loop prevention", () => {
  test("managed blocks and Tether-owned files are written; user text is untouched", async () => {
    await importAll();
    put(join(home, ".kiro", "settings", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    put(join(home, ".gemini", "antigravity", "mcp_config.json"), "");
    put(join(home, ".codex", "config.toml"), 'model = "gpt"\n');
    const r = await exportAll(store);
    const claudeMd = readFileSync(harness.claudeMd(), "utf8");
    expect(claudeMd.startsWith("# Global Guidance\n\n## Skills\n\n- grill-me: relentless design interviews.\n")).toBe(true);
    expect(claudeMd).toContain(`${BEGIN}\n@~/.config/tether/context/exports/global.md\n`);
    const codexMd = readFileSync(harness.codexAgentsMd(), "utf8");
    expect(codexMd.startsWith("## Tooling\n\nPrefer bun over npm for scripts.\n")).toBe(true);
    expect(codexMd).toContain("user-background"); // digest inlined
    expect(readFileSync(harness.piAgentsMd(), "utf8")).toContain(BEGIN);
    expect(existsSync(harness.opencodeAgentsMd())).toBe(false); // opencode not installed
    expect(readFileSync(harness.geminiMd(), "utf8")).toContain(`@${join(store.dir, "exports", "global.md")}`); // ~/.gemini exists (agy)
    // Per-repo Claude memory, out of the repo.
    const repoMem = join(harness.claudeProjects(), repo.replace(/[/.]/g, "-"), "memory");
    expect(readFileSync(join(repoMem, "tether.md"), "utf8")).toContain("fol deploy");
    expect(readFileSync(join(repoMem, "MEMORY.md"), "utf8")).toContain("(tether.md)");
    expect(readdirSync(repo)).toEqual([]); // nothing written into the repo
    // MCP registrations keep other servers.
    const kiro = JSON.parse(readFileSync(join(home, ".kiro", "settings", "mcp.json"), "utf8"));
    expect(Object.keys(kiro.mcpServers).sort()).toEqual(["other", "tether-context"]);
    expect(JSON.parse(readFileSync(join(home, ".gemini", "antigravity", "mcp_config.json"), "utf8")).mcpServers["tether-context"].args[0]).toEndWith("mcp.ts");
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(toml.startsWith('model = "gpt"\n')).toBe(true);
    expect(toml).toContain("[mcp_servers.tether-context]");
    expect(r.mcpConfigs.length).toBe(4); // codex, pi, kiro, antigravity
    expect(JSON.parse(readFileSync(harness.piMcp(), "utf8")).mcpServers["tether-context"].env.TETHER_CONTEXT_DIR).toBe(store.dir);
    // Idempotent: a second export changes nothing.
    expect((await exportAll(store)).written).toEqual([]);
  });

  test("an export never comes back as an import (no loops)", async () => {
    await importAll();
    await exportAll(store);
    expect((await scanSources(store, { changedOnly: true })).entries).toEqual([]);
    // And the user editing outside the block is picked up again.
    writeFileSync(harness.claudeMd(), readFileSync(harness.claudeMd(), "utf8") + "\n## New rule\n\nAlways run tests.\n");
    const changed = (await scanSources(store, { changedOnly: true })).entries;
    expect(changed.map((e) => e.title)).toEqual(["New rule"]);
  });

  test("the watcher ignores Tether's own writes but not the user's", async () => {
    await importAll();
    await exportAll(store);
    let fired = 0;
    const w = new Watcher(() => fired++, { debounceMs: 1, isOwn: isOwnWrite });
    w.add([harness.claudeMd()]);
    w.event(harness.claudeProjects(), "CLAUDE.md"); // wrong dir: filtered by the dir map
    w.event(join(home, ".claude"), "settings.json"); // other file in a watched dir
    w.event(join(home, ".claude"), "CLAUDE.md"); // Tether's own write
    w.event(join(home, ".claude"), "CLAUDE.md.tether-tmp");
    await Bun.sleep(20);
    expect(fired).toBe(0);
    writeFileSync(harness.claudeMd(), "user edit\n");
    expect(isOwnWrite(harness.claudeMd())).toBe(false);
    w.event(join(home, ".claude"), "CLAUDE.md");
    await Bun.sleep(20);
    expect(fired).toBe(1);
    w.stop();
  });

  test("the global digest stays under budget", async () => {
    for (let i = 0; i < 60; i++)
      await store.put(`global/fact-${i}`, { name: `fact-${i}`, description: `fact number ${i} `.repeat(4), type: i % 2 ? "user" : "project", scope: "global", sources: [], updated: new Date(2026, 0, 1, 0, i).toISOString(), body: "detail ".repeat(40) }, "t");
    const d = globalDigest(store);
    expect(Buffer.byteLength(d)).toBeLessThanOrEqual(4000);
    expect(d).toContain("more (memory_search)");
  });
});
