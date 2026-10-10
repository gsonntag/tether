// opencode's build/plan modes through the real adapter (OPENCODE_LIVE_TEST=1, OPENCODE_BIN=…):
// a new session reports them as the session's modes, and the mode picker's setPermissionMode
// switches opencode over the "mode" config option. Runs in a scratch HOME; no prompt is sent.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const live = !!process.env.OPENCODE_LIVE_TEST && !!process.env.OPENCODE_BIN;
const root = mkdtempSync(join(tmpdir(), "tether-oc-modes-"));
process.env.TETHER_CONFIG_DIR = join(root, "tether");
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
