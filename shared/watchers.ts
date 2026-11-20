// Watchers: what a session left running to wake it later (a background shell waiting on a file, a
// Monitor tailing a log, a workflow, a scheduled wakeup). With the main agent free and nothing else
// running, the session would look finished; it isn't: it comes back when one of these fires.
// Live state only (LiveState.watching): they die with the harness process, and so does this.

/** One thing a session waits on. */
export interface Watcher {
  /** shell: a background command; monitor: Monitor; workflow: Workflow; wakeup: ScheduleWakeup, CronCreate or /loop; task: another kind of background task */
  kind: "shell" | "monitor" | "workflow" | "wakeup" | "task";
  /** what it waits for, as the harness describes it (a wakeup: its prompt) */
  label: string;
  /** the subagent that started it (its title), when not the main agent */
  by?: string;
  /** a wakeup's next fire time (ms), when known */
  at?: number;
  /** a wakeup that fires again and again */
  recurring?: boolean;
}

/** What a session row says of its watchers (SessionSummary.watching). */
export interface WatchingSummary {
  n: number;
  /** the first one's label */
  label: string;
  /** the soonest known wakeup (ms) */
  at?: number;
}

const KIND_WORDS: Record<Watcher["kind"], string> = { shell: "background command", monitor: "monitor", workflow: "workflow", wakeup: "scheduled wakeup", task: "background task" };

/** The row's summary of a watcher list, or undefined when there are none. */
export function watchingSummary(list: Watcher[] | undefined): WatchingSummary | undefined {
  if (!list?.length) return undefined;
  const at = soonest(list);
  return { n: list.length, label: oneLine(list[0]!.label || KIND_WORDS[list[0]!.kind], 120), ...(at !== undefined ? { at } : {}) };
}

/** The soonest known wakeup time. */
export function soonest(list: Watcher[]): number | undefined {
  let at: number | undefined;
  for (const w of list) if (w.at !== undefined && (at === undefined || w.at < at)) at = w.at;
  return at;
}

/** One watcher in words, for the Home agent and tooltips: "monitor “replication progress.log” (subagent Step 1)". */
export function watcherText(w: Watcher): string {
  const label = w.label ? ` “${oneLine(w.label, 160)}”` : "";
  const by = w.by ? ` (started by subagent “${oneLine(w.by, 60)}”)` : "";
  const at = w.at !== undefined ? `, ${w.recurring ? "next fires" : "fires"} at ${new Date(w.at).toISOString()}` : w.recurring ? ", recurring" : "";
  return `${KIND_WORDS[w.kind]}${label}${by}${at}`;
}

const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ---------------- cron ----------------

/** The values one 5-field cron field allows, or undefined if it can't be read. */
function field(spec: string, min: number, max: number): Set<number> | undefined {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return undefined;
    const step = m[2] ? Number(m[2]) : 1;
    if (!step) return undefined;
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      const [a, b] = m[1]!.split("-").map(Number);
      lo = a!;
      hi = b ?? (m[2] ? max : a!);
    }
    if (lo < min || hi > max || lo > hi) return undefined;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/**
 * The next time (ms, after `from`) a 5-field cron expression matches, in the runner's local time
 * (as Claude Code's session crons fire), within a year; undefined if it can't be read or never does.
 */
export function nextCronFire(expr: string, from: number): number | undefined {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return undefined;
  const minute = field(f[0]!, 0, 59);
  const hour = field(f[1]!, 0, 23);
  const dom = field(f[2]!, 1, 31);
  const month = field(f[3]!, 1, 12);
  const dow = field(f[4]!.replace(/\b7\b/g, "0"), 0, 6);
  if (!minute || !hour || !dom || !month || !dow) return undefined;
  // Standard cron: with both day fields restricted, either may match.
  const anyDom = f[2] === "*";
  const anyDow = f[4] === "*";
  const dayOk = (d: Date) => (anyDom || anyDow ? dom.has(d.getDate()) && dow.has(d.getDay()) : dom.has(d.getDate()) || dow.has(d.getDay()));
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const end = from + 366 * 24 * 60 * 60 * 1000;
  while (d.getTime() <= end) {
    if (!month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayOk(d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }
  return undefined;
}
