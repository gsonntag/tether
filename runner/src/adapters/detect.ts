// Which harnesses this machine has, and their versions (`<bin> --version`). The adapters
// themselves arrive in P1 (Claude) and P4 (Codex).

import type { HarnessInfo } from "../../../shared/protocol";
import type { HarnessId } from "../../../shared/transcript";

export const HARNESS_BINS: Record<HarnessId, string> = {
  claude: process.env.CLAUDE_BIN || "claude",
  codex: process.env.CODEX_BIN || "codex",
};

/** "2.1.312 (Claude Code)" -> "2.1.312"; "codex-cli 0.164.0" -> "0.164.0" */
export function parseVersion(out: string): string | null {
  return out.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/)?.[0] ?? null;
}

const TIMED_OUT = Symbol("timed out");

async function versionOf(bin: string, timeoutMs: number): Promise<string | null | typeof TIMED_OUT> {
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  } catch {
    return null; // not installed
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Not waiting on stdout after a timeout: a wrapper script's children can hold the pipe open.
  const timedOut = new Promise<typeof TIMED_OUT>((ok) => (timer = setTimeout(() => (proc.kill(), ok(TIMED_OUT)), timeoutMs)));
  const answered = Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([out, code]) => (code === 0 ? parseVersion(out) : null));
  const version = await Promise.race([answered, timedOut]).catch(() => null);
  clearTimeout(timer);
  return version;
}

/** The versions seen last: a check that times out (a loaded machine) keeps the harness, not drops it. */
const lastSeen = new Map<HarnessId, string>();

export async function detectHarnesses(bins = HARNESS_BINS, timeoutMs = 30_000): Promise<HarnessInfo[]> {
  const found = await Promise.all(
    (Object.entries(bins) as [HarnessId, string][]).map(async ([id, bin]) => {
      const v = await versionOf(bin, timeoutMs);
      const version = v === TIMED_OUT ? lastSeen.get(id) : v;
      if (v === TIMED_OUT) console.log(`${bin} --version didn't answer in ${Math.round(timeoutMs / 1000)} s${version ? "; keeping the version seen before" : "; looking again later"}`);
      else if (v) lastSeen.set(id, v);
      else lastSeen.delete(id);
      return version ? { id, version } : null;
    }),
  );
  return found.filter((h): h is HarnessInfo => !!h);
}
