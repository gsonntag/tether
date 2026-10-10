// opencode's build/plan modes through the real adapter (OPENCODE_LIVE_TEST=1, OPENCODE_BIN=…):
// a new session reports them as the session's modes, and the mode picker's setPermissionMode
// switches opencode over the "mode" config option. Runs in a scratch HOME; no prompt is sent.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const live = !!process.env.OPENCODE_LIVE_TEST && !!process.env.OPENCODE_BIN;
const root = mkdtempSync(join(tmpdir(), "tether-oc-modes-"));
if (!process.env.TETHER_TEST_ROOT) process.env.TETHER_CONFIG_DIR = join(root, "tether");
if (live) {
  process.env.HOME = join(root, "home");
  process.env.XDG_CONFIG_HOME = join(root, "home", ".config");
  process.env.XDG_DATA_HOME = join(root, "home", ".local", "share");
  process.env.XDG_STATE_HOME = join(root, "home", ".local", "state");
  process.env.XDG_CACHE_HOME = join(root, "home", ".cache");
  mkdirSync(process.env.HOME, { recursive: true });
}
const { opencodeAdapter } = await import("./acp");
const { pickerModes } = await import("../../../web/src/modes");

const sink = { emit: () => {}, summary: () => {}, handoff: async () => {} };
let session: any;
afterAll(() => session?.close());

test.skipIf(!live)("opencode build/plan show in the mode picker and switch", async () => {
  const proj = join(root, "proj");
  mkdirSync(proj, { recursive: true });
  session = opencodeAdapter.create(proj, {}, sink as any);
  await session.start();
  expect(session.t.state.modes).toEqual(["build", "plan"]);
  expect(session.t.state.permissionMode).toBe("build");
  expect(pickerModes(session.t.state)).toEqual(["build", "plan"]);
  await session.setPermissionMode("plan");
  expect(session.t.state.permissionMode).toBe("plan");
  await session.setPermissionMode("build");
  expect(session.t.state.permissionMode).toBe("build");
}, 120_000);

// Needs a model that answers (OPENCODE_LIVE_PROMPT=1; opencode's free models work without a login).
test.skipIf(!live || !process.env.OPENCODE_LIVE_PROMPT)("a guard denial's reason reaches the opencode agent, which keeps going", async () => {
  const proj = join(root, "proj2");
  mkdirSync(proj, { recursive: true });
  const s: any = opencodeAdapter.create(proj, {}, sink as any);
  try {
    await s.start();
    const asked: string[] = [];
    s.checkTool = async (name: string) => {
      asked.push(name);
      return { allow: false, reason: "Shell commands are off today; the code word is PELICAN-7." };
    };
    await s.prompt("Use the bash tool to run `echo hi`. If it is blocked, tell me exactly what the block message said, then stop.");
    const end = Date.now() + 150_000;
    while (Date.now() < end && (s.t.state.status !== "idle" || !asked.length)) await Bun.sleep(500);
    const text = JSON.stringify(s.t.messages);
    expect(asked.length).toBeGreaterThan(0);
    expect(text).toContain("PELICAN-7"); // in the tool's error and/or the agent's reply
    const last = s.t.messages.filter((m: any) => m.role === "assistant").at(-1);
    console.log("agent said:", JSON.stringify(last?.parts?.filter((p: any) => p.type === "text")).slice(0, 400));
  } finally {
    s.close();
  }
}, 180_000);
