import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAntigravityCompatibility, realCompatDeps, realScreenCheck, realSubagentSteps, type CompatDeps } from "./compat";

const scratch = mkdtempSync(join(tmpdir(), "tether-agy-compat-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
/** An executable script in the scratch folder. */
const script = (name: string, body: string) => {
  const f = join(scratch, name);
  writeFileSync(f, body);
  chmodSync(f, 0o755);
  return f;
};

function fakeCompatDeps(over: Partial<CompatDeps> = {}): CompatDeps {
  return {
    which: (bin) => (bin === "agy" ? "/bin/agy" : null),
    run: async (argv) => (argv[1] === "--version" ? { code: 0, output: "1.5.14", timedOut: false } : { code: 0, output: "", timedOut: false }),
    initAcp: async () => ({
      version: "1.5.14",
      capabilities: { loadSession: true },
      configOptions: [{ id: "model", options: [] }, { id: "thought_level", options: [] }],
      listCount: 2,
    }),
    testStoreAndFork: async () => ({ integrity: true, replayed: true }),
    testSubagentFormat: async () => ({ ok: true, detail: "3 subagent conversations on disk decoded" }),
    testScreenParsing: async () => ({ ok: true, detail: "trust question, idle prompt box and typed text read from the real TUI" }),
    testLiveTurn: async () => true,
    ...over,
  };
}

describe("Antigravity compatibility check", () => {
  test("all checks pass when components behave as expected", async () => {
    const deps = fakeCompatDeps();
    const result = await checkAntigravityCompatibility({}, deps);
    expect(result.ok).toBe(true);
    expect(result.version).toBe("1.5.14");
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(result.output).toContain("All Antigravity compatibility checks passed for agy 1.5.14");
  });

  test("binary missing reports failure", async () => {
    const deps = fakeCompatDeps({ which: () => null });
    const result = await checkAntigravityCompatibility({}, deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('binary "agy" not found');
    expect(result.output).toContain("FAIL agy binary");
  });

  test("binary --version failure reports failure", async () => {
    const deps = fakeCompatDeps({ run: async () => ({ code: 1, output: "", timedOut: false }) });
    const result = await checkAntigravityCompatibility({}, deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("could not determine agy version");
    expect(result.output).toContain("FAIL agy binary");
  });

  test("ACP server failure reports failure", async () => {
    const deps = fakeCompatDeps({
      initAcp: async () => {
        throw new Error("connection refused");
      },
    });
    const result = await checkAntigravityCompatibility({}, deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("connection refused");
    expect(result.output).toContain("FAIL agy acp server");
  });

  test("ACP server missing model config options reports failure", async () => {
    const deps = fakeCompatDeps({
      initAcp: async () => ({
        version: "1.5.14",
        capabilities: { loadSession: true },
        configOptions: [],
        listCount: 0,
      }),
    });
    const result = await checkAntigravityCompatibility({}, deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing model configOptions");
    expect(result.output).toContain("FAIL agy acp server");
  });

  test("store and fork integrity failure reports failure", async () => {
    const deps = fakeCompatDeps({
      testStoreAndFork: async () => ({ integrity: false, replayed: true }),
    });
    const result = await checkAntigravityCompatibility({}, deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("SQLite integrity check failed");
    expect(result.output).toContain("FAIL store and fork");
  });

  test("subagent step format failure reports failure", async () => {
    const deps = fakeCompatDeps({
      testSubagentFormat: async () => ({ ok: false, detail: "1 of 3 subagent first steps on disk no longer decode" }),
    });
    const result = await checkAntigravityCompatibility({}, deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("subagent step format decoding failed: 1 of 3");
    expect(result.output).toContain("FAIL subagent format");
  });

  test("screen parsing failure reports failure", async () => {
    const deps = fakeCompatDeps({
      testScreenParsing: async () => ({ ok: false, detail: "the idle prompt box wasn't recognized" }),
    });
    const result = await checkAntigravityCompatibility({}, deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("screen parsing failed: the idle prompt box wasn't recognized");
    expect(result.output).toContain("FAIL screen parsing");
  });

  test("live turn is executed when requested with live: true", async () => {
    let ranLive = false;
    const deps = fakeCompatDeps({
      testLiveTurn: async () => {
        ranLive = true;
        return true;
      },
    });
    const result = await checkAntigravityCompatibility({ live: true }, deps);
    expect(result.ok).toBe(true);
    expect(ranLive).toBe(true);
    expect(result.output).toContain("ok   live prompt turn");
  });

  test("live turn failure reports failure", async () => {
    const deps = fakeCompatDeps({
      testLiveTurn: async () => false,
    });
    const result = await checkAntigravityCompatibility({ live: true }, deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("live prompt turn failed");
    expect(result.output).toContain("FAIL live turn");
  });

  test("what each check verified is reported, and a skipped screen check says so", async () => {
    const deps = fakeCompatDeps({ testScreenParsing: async () => ({ ok: true, skipped: true, detail: "tmux isn't installed" }) });
    const result = await checkAntigravityCompatibility({}, deps);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("ok   subagent step decoding (3 subagent conversations on disk decoded)");
    expect(result.output).toContain("skip terminal TUI screen parsing (tmux isn't installed)");
  });
});

describe("the real checks", () => {
  test("the live turn reads the reply from the client's updates and declines permission requests", async () => {
    const bin = script("agy-acp", `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fakeAgy.ts")}"\n`);
    expect(await realCompatDeps.testLiveTurn!(bin)).toBe(true);
  });

  test("subagent first steps on disk: each must decode; other conversations don't count", () => {
    const dir = mkdtempSync(join(scratch, "convs-"));
    const store = (id: string, step: string) => {
      const db = new Database(join(dir, `${id}.db`));
      db.run("create table steps (idx integer, step_payload blob)");
      db.query("insert into steps values (0, ?)").run(new Uint8Array(Buffer.from(step, "latin1")));
      db.close();
    };
    expect(realSubagentSteps(dir)).toEqual({ found: 0, failed: 0 });
    store("a", "\x12\x0a[Message] timestamp=2026-11-21T00:37:56Z sender=4afd15cc-2c80-4b26-adbc-60918bcdeee5 priority=MESSAGE_PRIORITY_HIGH content=Run ls.\x0a");
    store("b", "\x12\x05hello");
    expect(realSubagentSteps(dir)).toEqual({ found: 1, failed: 0 });
    // agy changes the line: the subagent is still found, and no longer decodes.
    store("c", "\x12\x0a[Message] from=4afd15cc-2c80-4b26-adbc-60918bcdeee5 body=Run ls.\x0a");
    expect(realSubagentSteps(dir)).toEqual({ found: 2, failed: 1 });
  });

  // A stand-in TUI: the trust question in a folder it isn't told to trust, else the prompt box (what's typed echoes into it).
  const RULE = "─".repeat(40);
  const tui = (prompt: string) =>
    script(
      `agy-tui-${prompt ? "ok" : "bad"}`,
      `#!/bin/sh\nif [ "$1" = "--settings" ]; then printf '${prompt}'; else printf 'Do you trust the contents of this project?\\n\\n> Yes, I trust this folder\\n  No, exit\\n\\n  ↑/↓ Navigate · enter Confirm\\n'; fi\nexec cat >/dev/null\n`,
    );
  test.skipIf(!Bun.which("tmux"))("the screen check reads the TUI's trust question, idle prompt box and typed text", async () => {
    const bin = tui(`${RULE}\\n> \\n${RULE}\\n? for shortcuts\\033[2A\\033[3G`);
    expect(await realScreenCheck(bin, { timeoutMs: 5000 })).toEqual({ ok: true, detail: "trust question, idle prompt box and typed text read from the real TUI" });
  });

  test.skipIf(!Bun.which("tmux"))("a TUI whose prompt box changed fails the screen check, with what it showed", async () => {
    const bin = tui("");
    const r = await realScreenCheck(bin, { timeoutMs: 1500 });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("the idle prompt box wasn't recognized");
  });
});
