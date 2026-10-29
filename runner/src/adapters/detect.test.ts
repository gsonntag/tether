import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectHarnesses, parseVersion } from "./detect";

test("versions as the CLIs print them", () => {
  expect(parseVersion("2.1.312 (Claude Code)\n")).toBe("2.1.312");
  expect(parseVersion("codex-cli 0.164.0\n")).toBe("0.164.0");
  expect(parseVersion("codex-cli 0.200.0-alpha.3")).toBe("0.200.0-alpha.3");
  expect(parseVersion("no version here")).toBeNull();
});

test("a harness counts only when its CLI runs and reports a version", async () => {
  const d = mkdtempSync(join(tmpdir(), "tether-bins-"));
  const script = (name: string, body: string) => {
    const p = join(d, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const found = await detectHarnesses({ claude: script("claude", 'echo "9.8.7 (Claude Code)"'), codex: join(d, "missing") });
  expect(found).toEqual([{ id: "claude", version: "9.8.7" }]);
  const broken = await detectHarnesses({ claude: script("bad", "exit 1"), codex: script("slow", "sleep 5; echo 1.0.0") }, 200);
  expect(broken).toEqual([]);
});
