// "Update all harnesses when all agents idle" (Settings → Updates): off by default. When on, the
// runner looks for harness updates every few hours (the checker's report and its cache), and when
// there are some it waits until every session is idle: no turn running, nobody waiting on the
// person, no queued messages, no background work, no retry countdown, no terminal open. Then it
// updates each harness that can be updated live, one at a time, looking again before each one and
// stopping if anything started. A failed update leaves the old version (the update paths install
// beside it or replace it whole) and isn't tried again for that version for a day.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { AutoUpdateResult, AutoUpdateStatus, HarnessVersion, UpdateRun } from "../../../../shared/harnessUpdates";
import type { SessionLook } from "..";
import type { UpdateChecker } from "./check";

/** How often the versions are looked at again. */
export const CHECK_EVERY_MS = 4 * 60 * 60_000;
/** How often it looks whether it's time (and, while updates wait, whether everything is idle). */
export const TICK_MS = 2 * 60_000;
/** A version whose update failed isn't tried again for this long. */
export const FAILED_BACKOFF_MS = 24 * 60 * 60_000;
const OUTPUT_KEEP = 2000;

interface Saved {
  enabled?: boolean;
  lastCheckAt?: number;
  last?: AutoUpdateStatus["last"];
  /** harness id → the version that failed to install, and when */
  failed?: Record<string, { version?: string; at: number }>;
}

/** What keeps a session from counting as idle, or undefined when it is idle. */
export function sessionBusy(l: SessionLook): string | undefined {
  if (l.status === "running") return "running a turn";
  if (l.status === "waiting" || l.requests.length || l.state.requests.length) return "waiting on the person";
  if (l.state.queue.length) return "has queued messages";
  if (l.state.retry) return "waiting to retry";
  if (l.state.terminal) return "open in a terminal";
  if (l.busy || l.background) return "running background work";
  return undefined;
}

/** Why the runner isn't idle ("2 sessions are busy"), or undefined when every session is. */
export function busyReason(looks: SessionLook[]): string | undefined {
  const busy = looks.map((l) => ({ l, why: sessionBusy(l) })).filter((b) => b.why);
  if (!busy.length) return undefined;
  if (busy.length > 1) return `${busy.length} sessions are busy`;
  const { l, why } = busy[0]!;
  return `"${l.summary.title || "Untitled"}" is ${why}`;
}

/** The Home agent's one-line report of an auto-update. */
export function reportLine(last: NonNullable<AutoUpdateStatus["last"]>): string {
  const parts = last.results.map((r) => (r.ok ? `Auto-updated ${r.name} ${r.from ?? "?"} → ${r.to ?? "?"}.` : `Auto-update of ${r.name} failed (${r.error ?? "unknown error"}); it stays on ${r.from ?? "its old version"}.`));
  if (last.aborted) parts.push(last.aborted);
  return parts.join(" ");
}

export interface AutoUpdaterOptions {
  checker: Pick<UpdateChecker, "report" | "updateAndWait">;
  /** every session in memory */
  looks: () => SessionLook[];
  /** where the setting and the last result are kept; none: memory only (tests) */
  file?: string;
  now?: () => number;
  log?: (line: string) => void;
  /** tells the Home agent what an auto-update did */
  notify?: (text: string) => Promise<void> | void;
}

export class AutoUpdater {
  private saved: Saved = {};
  private waiting?: AutoUpdateStatus["waiting"];
  private ticking = false;
  private timer?: ReturnType<typeof setInterval>;
  private now: () => number;

  constructor(private o: AutoUpdaterOptions) {
    this.now = o.now ?? Date.now;
    if (o.file && existsSync(o.file)) {
      try {
        const s = JSON.parse(readFileSync(o.file, "utf8"));
        if (s && typeof s === "object") this.saved = s;
      } catch {}
    }
  }

  status(): AutoUpdateStatus {
    return { enabled: this.saved.enabled === true, ...(this.waiting && this.saved.enabled ? { waiting: this.waiting } : {}), ...(this.saved.last ? { last: this.saved.last } : {}) };
  }

  set(on: boolean): AutoUpdateStatus {
    this.saved.enabled = on;
    if (!on) this.waiting = undefined;
    // Turned on: look at the next tick (within TICK_MS), not hours from the last look.
    else delete this.saved.lastCheckAt;
    this.save();
    return this.status();
  }

  start(): () => void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    return () => clearInterval(this.timer);
  }

  /** One look: due for a check, or updates waiting, then update if every session is idle. */
  async tick(): Promise<void> {
    if (!this.saved.enabled || this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const due = !this.saved.lastCheckAt || now - this.saved.lastCheckAt >= CHECK_EVERY_MS;
      if (!due && !this.waiting) return;
      const report = await this.o.checker.report();
      if (due) {
        this.saved.lastCheckAt = now;
        this.save();
      }
      const targets = report.harnesses.filter((h) => this.wanted(h, now));
      if (!targets.length) {
        this.waiting = undefined;
        return;
      }
      const why = busyReason(this.o.looks());
      if (why) {
        this.waiting = { since: this.waiting?.since ?? now, harnesses: targets.map((h) => h.name), why };
        return;
      }
      this.waiting = undefined;
      await this.apply(targets);
    } catch (e) {
      this.o.log?.(`auto-update: ${(e as Error)?.message ?? e}`);
    } finally {
      this.ticking = false;
    }
  }

  private wanted(h: HarnessVersion, now: number): boolean {
    if (h.status !== "available" || !h.updatable || h.method === "bundled") return false;
    if (h.update?.state === "queued" || h.update?.state === "running") return false;
    const f = this.saved.failed?.[h.id];
    return !(f && f.version === h.latest && now - f.at < FAILED_BACKOFF_MS);
  }

  private async apply(targets: HarnessVersion[]) {
    const results: AutoUpdateResult[] = [];
    let aborted: string | undefined;
    for (const h of targets) {
      // Something may have started since the last one (or since the idle look).
      const why = busyReason(this.o.looks());
      if (why) {
        aborted = `Stopped before updating ${h.name}: ${why}.`;
        this.waiting = { since: this.now(), harnesses: targets.slice(targets.indexOf(h)).map((t) => t.name), why };
        break;
      }
      this.o.log?.(`auto-update: updating ${h.name} ${h.installed} → ${h.latest}`);
      const run: UpdateRun = await this.o.checker.updateAndWait(h.id).catch((e) => ({ state: "failed" as const, startedAt: this.now(), output: "", command: h.command ?? "", from: h.installed, error: (e as Error)?.message ?? String(e) }));
      const ok = run.state === "done";
      results.push({ id: h.id, name: h.name, from: run.from ?? h.installed, ...(run.to ? { to: run.to } : {}), ok, ...(run.error ? { error: run.error } : {}), ...(run.output ? { output: run.output.slice(-OUTPUT_KEEP) } : {}) });
      if (!ok) (this.saved.failed ??= {})[h.id] = { version: h.latest, at: this.now() };
      else delete this.saved.failed?.[h.id];
    }
    if (!results.length && !aborted) return;
    const last = { at: this.now(), results, ...(aborted ? { aborted } : {}) };
    this.saved.last = last;
    this.save();
    this.o.log?.(`auto-update: ${reportLine(last)}`);
    if (results.length) {
      try {
        await this.o.notify?.(reportLine(last));
      } catch (e) {
        this.o.log?.(`auto-update: couldn't tell the Home agent: ${(e as Error)?.message ?? e}`);
      }
    }
  }

  private save() {
    if (!this.o.file) return;
    try {
      const tmp = `${this.o.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.saved), { mode: 0o600 });
      renameSync(tmp, this.o.file);
    } catch (e) {
      this.o.log?.(`auto-update: couldn't save: ${(e as Error)?.message ?? e}`);
    }
  }
}
