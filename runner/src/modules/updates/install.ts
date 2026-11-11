// How a harness was installed, told from where its binary really lives, and the command that
// updates it that way. Pure: the checker (check.ts) hands in the resolved paths.

import { dirname, join, sep } from "node:path";
import type { InstallMethod } from "../../../../shared/harnessUpdates";

export interface Install {
  method: InstallMethod;
  /** npm: the global prefix (its bin/ holds the npm and node to update with) */
  prefix?: string;
}

/** A harness Tether knows how to look up and update. */
export interface HarnessSpec {
  id: string;
  name: string;
  /** the npm package its releases are published as */
  pkg: string;
  /** the CLI on PATH; none for a package bundled with the runner */
  bin?: string;
  /** Homebrew's name for it */
  brew?: string;
}

/**
 * The install method from the binary's real path (symlinks resolved):
 * - `~/.local/share/claude/versions/2.1.322` → native (Claude's installer)
 * - `<prefix>/lib/node_modules/@openai/codex/bin/codex.js` → npm, prefix `<prefix>`
 * - `~/.bun/install/global/node_modules/…` → bun
 * - `/opt/homebrew/…`, `/usr/local/Cellar/…`, `/home/linuxbrew/…`, `…/Caskroom/…` → brew
 */
export function detectInstall(realPath: string, pkg: string): Install {
  const p = realPath.split(sep).join("/");
  if (/\/claude\/versions\/[^/]+$/.test(p) || /\/\.claude\/local\//.test(p)) return { method: "native" };
  if (/\/(Cellar|Caskroom)\//.test(p) || p.startsWith("/opt/homebrew/") || p.startsWith("/home/linuxbrew/")) return { method: "brew" };
  if (p.includes("/.bun/install/global/node_modules/")) return { method: "bun" };
  const marker = `/lib/node_modules/${pkg}/`;
  const i = p.indexOf(marker);
  if (i > 0) return { method: "npm", prefix: p.slice(0, i) };
  // Windows-style npm prefix (no lib/): <prefix>/node_modules/<pkg>/
  const j = p.indexOf(`/node_modules/${pkg}/`);
  if (j > 0 && !p.slice(0, j).includes("/node_modules")) return { method: "npm", prefix: p.slice(0, j) };
  return { method: "unknown" };
}

export interface UpdatePlan {
  argv: string[];
  /** extra environment: npm's own node first on PATH */
  env?: Record<string, string>;
}

/**
 * The command that updates a harness installed by `install` to `version` (or its channel's newest
 * where the tool picks: `claude update`). None for bundled or unknown installs.
 */
export function updatePlan(spec: HarnessSpec, install: Install, version: string | undefined, binPath: string | undefined, path = process.env.PATH ?? ""): UpdatePlan | undefined {
  const target = `${spec.pkg}@${version ?? "latest"}`;
  switch (install.method) {
    case "native":
      return binPath ? { argv: [binPath, "update"] } : undefined;
    case "npm": {
      if (!install.prefix) return undefined;
      const bin = join(install.prefix, "bin");
      // nvm's npm is `#!/usr/bin/env node`: the node beside it must come first.
      return { argv: [join(bin, "npm"), "install", "-g", target], env: { PATH: `${bin}:${path}` } };
    }
    case "bun":
      return { argv: ["bun", "add", "-g", target] };
    case "brew":
      return spec.brew ? { argv: ["brew", "upgrade", spec.brew] } : undefined;
    default:
      return undefined;
  }
}

/** The plan as a line people read. */
export function commandLine(plan: UpdatePlan): string {
  const [cmd, ...rest] = plan.argv;
  const home = process.env.HOME;
  const short = (s: string) => (home && s.startsWith(home + "/") ? "~" + s.slice(home.length) : s);
  return [cmd ? short(cmd) : "", ...rest].join(" ");
}

/** What updating it changes for sessions: none are stopped. */
export function effectNote(spec: HarnessSpec, method: InstallMethod): string | undefined {
  if (method === "bundled") return "Part of Tether's runner: it moves with a Tether release.";
  if (method === "unknown") return "Installed in a way Tether can't update. Update it on the machine.";
  if (spec.id === "codex") return "Running sessions aren't stopped. Codex's app server keeps the old version until it restarts; terminal sessions get the new one at once.";
  return "Running sessions aren't stopped and keep their version; new sessions and restarts get the new one.";
}

/** The package.json of a package the runner depends on (bundled harnesses). */
export function bundledPackageJson(pkg: string, from = import.meta.dir): string {
  return join(dirname(dirname(dirname(from))), "node_modules", pkg, "package.json");
}
