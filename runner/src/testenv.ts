// Preloaded before every test file (runner/bunfig.toml), and imported by the context tests for
// runs outside runner/: points HOME, the runner config and the store at one scratch directory for
// the whole `bun test` process (all files share it), so no test can touch the real ~/.claude,
// ~/.codex, ~/.config/tether, … and no file's env changes leak into another's.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.env.TETHER_TEST_ROOT ?? mkdtempSync(join(tmpdir(), "tether-ctx-test-"));
process.env.TETHER_TEST_ROOT = root;
process.env.HOME = join(root, "home");
process.env.TETHER_CONFIG_DIR = join(root, "home", ".config", "tether");
delete process.env.TETHER_CONTEXT_DIR;
// never the runner's own relay connection
delete process.env.TETHER_URL;
delete process.env.TETHER_TOKEN;
// harness homes that would point outside the scratch HOME
delete process.env.CODEX_HOME;
delete process.env.PI_CODING_AGENT_SESSION_DIR;
process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
mkdirSync(process.env.HOME, { recursive: true });

if (!process.env.HOME.startsWith(tmpdir())) throw new Error("test HOME must be a temp dir");

const SCRATCH_HOME = process.env.HOME;

/** Empties the scratch home between tests (and puts HOME back if a test pointed it elsewhere). */
export function resetHome() {
  process.env.HOME = SCRATCH_HOME;
  rmSync(process.env.HOME!, { recursive: true, force: true });
  mkdirSync(process.env.HOME!, { recursive: true });
}

export const HOME = process.env.HOME!;
