// Settings → Updates: the words and choices the page needs, kept pure for tests.

import type { AutoUpdateStatus, HarnessReport, HarnessVersion, InstallMethod } from "../../shared/harnessUpdates";

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
export const canUpdate = (h: HarnessVersion) => h.status === "available" && h.updatable && !updating(h);

/** What "Update all" would start, runner by runner: every row that can update. Bundled ones never do. */
export function updateAllTargets(reports: Record<string, HarnessReport | undefined>, online: (runnerId: string) => boolean): { runnerId: string; id: string }[] {
  return Object.entries(reports).flatMap(([runnerId, r]) => (r && online(runnerId) ? r.harnesses.filter(canUpdate).map((h) => ({ runnerId, id: h.id })) : []));
}

/** The line under a row with an update: where it is or how it ended. */
export function runLine(h: HarnessVersion): string | undefined {
  const u = h.update;
  if (!u) return undefined;
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
