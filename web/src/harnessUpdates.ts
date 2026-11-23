// Settings → Updates: the words and choices the page needs, kept pure for tests.

import type { AutoUpdateStatus, HarnessReport, HarnessVersion, InstallMethod, RunnerUpdateStatus } from "../../shared/harnessUpdates";

export const METHOD_LABELS: Record<InstallMethod, string> = {
  native: "Native installer",
  npm: "npm, global",
  bun: "bun, global",
  brew: "Homebrew",
  bundled: "Bundled with Tether",
  unknown: "Unknown install",
};

/** An update that's queued or running. */
export const updating = (h: HarnessVersion) => h.update?.state === "queued" || h.update?.state === "running";

/** Whether a row shows its Update button: a newer version, a way to install it, and nothing going. */
export const canUpdate = (h: HarnessVersion) =>
  ((h.status === "available" && h.updatable) || (h.id === "antigravity" && !!h.installed && h.updatable)) && !updating(h);

/** What "Update all" would start, runner by runner: every row that can update. Bundled ones never do. */
export function updateAllTargets(reports: Record<string, HarnessReport | undefined>, online: (runnerId: string) => boolean): { runnerId: string; id: string }[] {
  return Object.entries(reports).flatMap(([runnerId, r]) =>
    r && online(runnerId) ? r.harnesses.filter((h) => h.id !== "antigravity" && canUpdate(h)).map((h) => ({ runnerId, id: h.id })) : [],
  );
}

/** The line under a row with an update: where it is or how it ended. */
export function runLine(h: HarnessVersion): string | undefined {
  const u = h.update;
  if (!u) return undefined;
  if (h.id === "antigravity") {
    if (u.state === "queued") return "Waiting to run check…";
    if (u.state === "running") return "Checking compatibility…";
    if (u.state === "failed") return `Compatibility check failed: ${u.error ?? "unknown error"}`;
    return "Compatibility checks passed";
  }
  if (u.state === "queued") return "Waiting for another update to finish…";
  if (u.state === "running") return "Updating…";
  if (u.state === "failed") return `Update failed: ${u.error ?? "unknown error"}`;
  return u.to && u.from && u.to !== u.from ? `Updated ${u.from} → ${u.to}` : `Update finished${u.to ? ` (${u.to})` : ""}`;
}

/** "Checked just now", "Checked 4 min ago". */
export function checkedAgo(at: number, now: number): string {
  const min = Math.floor((now - at) / 60_000);
  return min < 1 ? "Checked just now" : min < 60 ? `Checked ${min} min ago` : `Checked ${Math.floor(min / 60)} h ago`;
}

/** The auto-update's lines: what it waits for, and its last run ("Last auto-update 2 h ago: Codex 0.164.0 → 0.167.1"). */
export function autoLines(a: AutoUpdateStatus, now: number): { waiting?: string; last?: string } {
  const ago = (at: number) => checkedAgo(at, now).replace(/^Checked /, "");
  const waiting = a.enabled && a.waiting ? `Waiting for all agents to be idle to update ${a.waiting.harnesses.join(", ")} (${a.waiting.why}).` : undefined;
  const l = a.last;
  const parts = l ? [...l.results.map((r) => (r.ok ? `${r.name} ${r.from ?? "?"} → ${r.to ?? "?"}` : `${r.name} failed: ${r.error ?? "unknown error"} (still ${r.from ?? "on its old version"})`)), ...(l.aborted ? [l.aborted] : [])] : [];
  return { ...(waiting ? { waiting } : {}), ...(l ? { last: `Last auto-update ${ago(l.at)}: ${parts.join("; ") || "nothing updated"}` } : {}) };
}

/** "Update the runner when all agents idle": what the runner runs, what it waits for, and its last update. */
export function runnerUpdateLines(r: RunnerUpdateStatus, now: number): { state?: string; last?: string } {
  const ago = (at: number) => checkedAgo(at, now).replace(/^Checked /, "");
  const sh = (c?: string) => (c ?? "?").slice(0, 7);
  const behind = r.available ? `${r.available.behind} commit${r.available.behind === 1 ? "" : "s"} behind main` : undefined;
  const state = r.unsupported
    ? r.unsupported
    : r.enabled && r.waiting
      ? `${behind ? `${behind}. ` : ""}Waiting to update and restart: ${r.waiting.why}.`
      : behind
        ? `${behind}.`
        : r.enabled && r.commit
          ? `Up to date (${sh(r.commit)}).`
          : undefined;
  const l = r.last;
  const last = l ? (l.ok ? `Last update ${ago(l.at)}: ${sh(l.from)} → ${sh(l.to)}, restarted.` : `Last update ${ago(l.at)} failed: ${l.error ?? "unknown error"} (still ${sh(l.from)}).`) : undefined;
  return { ...(state ? { state } : {}), ...(last ? { last } : {}) };
}
