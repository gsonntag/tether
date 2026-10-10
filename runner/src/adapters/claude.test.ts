import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// (the preloaded src/testenv.ts already points it at the shared scratch dir)
if (!process.env.TETHER_TEST_ROOT) process.env.TETHER_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tether-claude-"));
const { keepsGuard } = await import("./claude");

test("only modes that still ask canUseTool survive a handoff or a guard change", () => {
  // plan mode is kept (a guard change must not drop the person out of planning)
  expect(keepsGuard("default")).toBe(true);
  expect(keepsGuard("plan")).toBe(true);
  // Claude's approving modes would answer before the guard is asked; other harnesses' modes mean nothing here
  for (const m of ["acceptEdits", "auto", "bypassPermissions", "dontAsk", "build", "", undefined]) expect(keepsGuard(m)).toBe(false);
});
