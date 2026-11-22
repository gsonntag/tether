import { describe, expect, test } from "bun:test";
import { checkAntigravityCompatibility, type CompatDeps } from "./compat";

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
    testSubagentFormat: async () => true,
    testScreenParsing: () => true,
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
      testSubagentFormat: async () => false,
    });
    const result = await checkAntigravityCompatibility({}, deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("subagent step format decoding failed");
    expect(result.output).toContain("FAIL subagent format");
  });

  test("screen parsing failure reports failure", async () => {
    const deps = fakeCompatDeps({
      testScreenParsing: () => false,
    });
    const result = await checkAntigravityCompatibility({}, deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("screen parsing failed");
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
});
