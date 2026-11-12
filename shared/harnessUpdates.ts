// Harness updates (Settings → Updates; the harnessVersions and harnessUpdate ops): what each
// harness on a runner is at, what the newest release is, and how it was installed, which decides
// how (and whether) Tether can update it. The pure parts live here so runner and web agree.

/** How a harness got onto the machine: it decides the update path. */
export type InstallMethod =
  /** Claude Code's native installer (~/.local/share/claude/versions/<v>): `claude update` */
  | "native"
  /** a global npm package: `npm i -g <pkg>@latest` with the npm next to it */
  | "npm"
  /** a global bun package: `bun add -g <pkg>@latest` */
  | "bun"
  /** Homebrew: `brew upgrade` */
  | "brew"
  /** a dependency of Tether's runner itself: only a Tether release moves it */
  | "bundled"
  /** found, but not in a way Tether knows how to update */
  | "unknown";

export type UpdateStatus =
  | "current"
  | "available"
  /** the latest release couldn't be found (network, timeout, no registry entry) */
  | "unknown"
  /** not installed on this runner */
  | "missing";

/** One update run (harnessUpdate): kept until the next one for that harness. */
export interface UpdateRun {
  /** queued: waiting for another update on this runner to end (they run one at a time) */
  state: "queued" | "running" | "done" | "failed";
  startedAt: number;
  endedAt?: number;
  /** what the command printed (the end of it), stdout and stderr together */
  output: string;
  /** the command, as it ran */
  command: string;
  /** the version before, and after (a fresh `--version`) once it ends */
  from?: string;
  to?: string;
  error?: string;
}

export interface HarnessVersion {
  /** "claude", "codex", or a bundled package ("claude-agent-sdk") */
  id: string;
  name: string;
  /** the npm package its releases are published as */
  pkg: string;
  installed?: string;
  latest?: string;
  status: UpdateStatus;
  method: InstallMethod;
  /** where it was found (the resolved binary or package folder) */
  path?: string;
  /** Tether can run the update itself (a known method, not bundled) */
  updatable: boolean;
  /** the command an update runs, for the person to see first */
  command?: string;
  /** what an update changes and when it takes effect */
  note?: string;
  /** why the latest version couldn't be found */
  error?: string;
  update?: UpdateRun;
}

export interface HarnessReport {
  /** when the versions were last looked up (cached a few minutes) */
  checkedAt: number;
  harnesses: HarnessVersion[];
  /** "Update all harnesses when all agents idle" (absent from a runner from before it) */
  auto?: AutoUpdateStatus;
}

/** One harness an auto-update updated (or tried to). */
export interface AutoUpdateResult {
  id: string;
  name: string;
  from?: string;
  to?: string;
  ok: boolean;
  error?: string;
  /** the end of what the update printed */
  output?: string;
}

/** The runner's auto-update: off by default; when on, it updates once every session is idle. */
export interface AutoUpdateStatus {
  enabled: boolean;
  /** updates found and waiting for every session to be idle */
  waiting?: { since: number; harnesses: string[]; why: string };
  /** the last auto-update that ran (or stopped because a session started) */
  last?: { at: number; results: AutoUpdateResult[]; aborted?: string };
}

const NUM = /(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?/;

/** The first version in a CLI's output: "2.1.312 (Claude Code)" → "2.1.312"; "codex-cli 0.164.0" → "0.164.0". */
export function parseVersion(out: string): string | null {
  const m = out.match(NUM);
  return m ? m[0] : null;
}

interface Parsed {
  nums: [number, number, number];
  pre: string[];
}

function parse(v: string): Parsed | null {
  const m = v.trim().replace(/^v/i, "").match(new RegExp(`^${NUM.source}$`));
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)], pre: m[4] ? m[4].split(".") : [] };
}

/**
 * Semver order: <0 when a is older, 0 the same, >0 newer. A prerelease comes before its release
 * (0.170.0-alpha.1 < 0.170.0). Null when either isn't a version.
 */
export function compareVersions(a: string, b: string): number | null {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i]! - y.nums[i]!;
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) - Number(q);
    } else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** Where a harness stands. A build newer than the latest release (a prerelease, a next tag) is current. */
export function updateStatus(installed: string | undefined, latest: string | undefined): UpdateStatus {
  if (!installed) return "missing";
  if (!latest) return "unknown";
  const c = compareVersions(installed, latest);
  if (c === null) return "unknown";
  return c < 0 ? "available" : "current";
}

/** Words for a status, as the table shows them. */
export function statusLabel(h: Pick<HarnessVersion, "status" | "method">): string {
  if (h.status === "available") return h.method === "bundled" ? "Needs a Tether release" : "Update available";
  return h.status === "current" ? "Up to date" : h.status === "missing" ? "Not installed" : "Couldn't check";
}
