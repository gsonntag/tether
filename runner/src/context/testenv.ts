// Imported first by every context test: points HOME, the runner config and the store at a
// scratch directory, so no test can touch the real ~/.claude, ~/.codex, ~/.config/tether, ….

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.env.TETHER_TEST_ROOT ?? mkdtempSync(join(tmpdir(), "tether-ctx-test-"));
process.env.TETHER_TEST_ROOT = root;
process.env.HOME = join(root, "home");
process.env.TETHER_CONFIG_DIR = join(root, "home", ".config", "tether");
delete process.env.TETHER_CONTEXT_DIR;
process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
mkdirSync(process.env.HOME, { recursive: true });

if (!process.env.HOME.startsWith(tmpdir())) throw new Error("test HOME must be a temp dir");

/** Empties the scratch home between tests. */
export function resetHome() {
  rmSync(process.env.HOME!, { recursive: true, force: true });
  mkdirSync(process.env.HOME!, { recursive: true });
}

export const HOME = process.env.HOME!;
