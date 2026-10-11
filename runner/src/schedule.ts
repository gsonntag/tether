// /loop and /schedule: prompts the runner sends to a session on a timer (docs/harness-platform.md,
// Phase 4). They are Tether's own, on every harness, and independent of a harness's own crons
// (Claude Code's CronCreate / ScheduleWakeup / /loop, which die with its process and are only
// displayed). State lives on the session (LiveState.schedules, saved with its prefs in runner.json),
// so it survives a runner restart, and a handoff moves it to the new session.
//
// A due run goes into the session's pending list as a queued user message (session.ts queueRun):
// sent at once when the session is idle, otherwise when the running turn ends. While one run of a
// schedule waits there, further runs of it collapse into that one.
//
// This file is the part without a session: the commands, cron expressions, the next run time and
// the runner-wide timer (Scheduler) that opens a closed session when one of its runs is due.

import type { SessionSchedule } from "../../web/src/shared/protocol";
import { bySoonest, fmtWhen, kindLabel } from "../../web/src/shared/schedule";

export { bySoonest, fmtWhen, kindLabel } from "../../web/src/shared/schedule";

/** The shortest loop interval. */
export const MIN_LOOP_MS = 60_000;
/** A session keeps at most this many loops and schedules. */
export const MAX_SCHEDULES = 20;
const PROMPT_MAX = 4_000;

// ---------------- durations and times ----------------

/** "10m", "2h", "1h30m", "90s", "1d", "every 10m" without the "every" */
export function parseInterval(v: string): number | undefined {
  const m = v.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m(?:in)?)?(?:(\d+)s)?$/i);
  if (!m || !v) return undefined;
  const ms = (Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0)) * 1000;
  return ms > 0 ? ms : undefined;
}

/** "10m", "1h 30m", "1d" */
export function fmtInterval(ms: number): string {
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return [d ? `${d}d` : "", h ? `${h}h` : "", m ? `${m}m` : "", s ? `${s}s` : ""].filter(Boolean).join(" ") || "0m";
}

/** "15:00", "3pm", "3:30pm", "9am": [hours, minutes] */
function parseClock(v: string): [number, number] | undefined {
  const m = v.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/i);
  if (!m || (!m[2] && !m[3])) return undefined;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3]) {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
  }
  return h <= 23 && min <= 59 ? [h, min] : undefined;
}

/**
 * `at [today|tomorrow|YYYY-MM-DD] <15:00|3pm|3:30pm>` (local time): when, and how many words it
 * took. A time already past today means tomorrow; a past date is an error.
 */
export function parseAt(words: string[], now = Date.now()): { at: number; used: number } | { error: string } | undefined {
  let i = 0;
  let date: Date | undefined;
  const w0 = words[0]?.toLowerCase();
  const base = new Date(now);
  if (w0 === "today" || w0 === "tomorrow") {
    date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + (w0 === "tomorrow" ? 1 : 0));
    i = 1;
  } else if (w0 && /^\d{4}-\d{2}-\d{2}$/.test(w0)) {
    const [y, mo, d] = w0.split("-").map(Number) as [number, number, number];
    date = new Date(y, mo - 1, d);
    if (date.getMonth() !== mo - 1) return { error: `"${words[0]}" isn't a date.` };
    i = 1;
  }
  const clock = words[i] ? parseClock(words[i]!) : undefined;
  if (!clock) return undefined;
  const day = date ?? new Date(base.getFullYear(), base.getMonth(), base.getDate());
  let at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), clock[0], clock[1]).getTime();
  if (at <= now) {
    if (date) return { error: `${fmtWhen(at, now)} has passed already.` };
    at = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, clock[0], clock[1]).getTime();
  }
  return { at, used: i + 1 };
}

// ---------------- cron ----------------

export interface Cron {
  minute: number[];
  hour: number[];
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** the field was `*` (or `*` with a step): with both restricted, either day field matching is enough */
  domAny: boolean;
  dowAny: boolean;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

/** One cron field: `*`, `5`, `1-5`, `*\/15`, `1-30/2`, lists of these, month and day names. */
function parseField(v: string, min: number, max: number, names?: string[], offset = 0): number[] | undefined {
  const out = new Set<number>();
  const value = (s: string) => {
    const i = names?.indexOf(s.toLowerCase()) ?? -1;
    if (i >= 0) return i + offset;
    return /^\d+$/.test(s) ? Number(s) : NaN;
  };
  for (const item of v.split(",")) {
    const m = item.match(/^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/i);
    if (!m) return undefined;
    const step = m[2] ? Number(m[2]) : 1;
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      const [a, b] = m[1]!.split("-");
      lo = value(a!);
      hi = b !== undefined ? value(b) : m[2] ? max : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi || step < 1) return undefined;
    for (let n = lo; n <= hi; n += step) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** A 5-field cron expression ("M H DoM Mon DoW", local time) or a macro like @daily; a string is the error. */
export function parseCron(expr: string): Cron | string {
  const text = MACROS[expr.trim().toLowerCase()] ?? expr.trim();
  const f = text.split(/\s+/);
  if (f.length !== 5) return `"${expr}" isn't a cron expression: it needs 5 fields (minute hour day-of-month month day-of-week).`;
  const minute = parseField(f[0]!, 0, 59);
  const hour = parseField(f[1]!, 0, 23);
  const dom = parseField(f[2]!, 1, 31);
  const month = parseField(f[3]!, 1, 12, MONTH_NAMES, 1);
  const dow = parseField(f[4]!, 0, 7, DAY_NAMES);
  const bad = [minute, hour, dom, month, dow].findIndex((x) => !x);
  if (bad >= 0) return `"${f[bad]}" isn't a valid ${["minute", "hour", "day-of-month", "month", "day-of-week"][bad]} field.`;
  return {
    minute: minute!,
    hour: hour!,
    dom: new Set(dom),
    month: new Set(month),
    dow: new Set(dow!.map((d) => d % 7)),
    domAny: f[2]!.startsWith("*"),
    dowAny: f[4]!.startsWith("*"),
  };
}

/** Whether the cron runs on this (local) day. */
function dayMatches(c: Cron, d: Date): boolean {
  if (!c.month.has(d.getMonth() + 1)) return false;
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  return c.domAny || c.dowAny ? dom && dow : dom || dow;
}

/** The first run strictly after `after` (local time, to the minute); undefined if it never runs again. */
export function nextCron(c: Cron, after: number): number | undefined {
  const start = Math.floor(after / 60_000) * 60_000 + 60_000;
  const s = new Date(start);
  // Five years covers every expression that can run at all (Feb 29 on a given weekday included).
  for (let i = 0; i < 366 * 5; i++) {
    const day = new Date(s.getFullYear(), s.getMonth(), s.getDate() + i);
    if (!dayMatches(c, day)) continue;
    for (const h of c.hour)
      for (const m of c.minute) {
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
        // A time a clock change skips doesn't exist that day.
        if (t.getHours() !== h || t.getMinutes() !== m) continue;
        if (t.getTime() >= start) return t.getTime();
      }
  }
  return undefined;
}

// ---------------- the commands ----------------

export type ScheduleCommand =
  | { cmd: "list"; kind: "loop" | "schedule" }
  | { cmd: "add"; kind: SessionSchedule["kind"]; prompt: string; label: string; everyMs?: number; cron?: string; at?: number }
  | { cmd: "remove"; kind: "loop" | "schedule"; which: number | "all" }
  | { cmd: "error"; text: string };

const LOOP_USAGE = "Use /loop <interval> <prompt> (for example /loop 10m check CI and fix failures), /loop list, or /loop stop [n].";
const SCHEDULE_USAGE =
  'Use /schedule <cron> <prompt> (for example /schedule 0 9 * * 1-5 summarize open PRs), /schedule at 15:00 <prompt>, /schedule in 2h <prompt>, /schedule list, or /schedule delete <n>.';

/** A prompt a loop or schedule may send: not one of Tether's own commands. */
function checkPrompt(prompt: string, usage: string): string | undefined {
  if (!prompt) return `Say what to send. ${usage}`;
  if (/^\/(loop|schedule|goal)(\s|$)/i.test(prompt)) return "A loop or schedule can't run /loop, /schedule or /goal.";
  if (prompt.length > PROMPT_MAX) return `The prompt is too long (at most ${PROMPT_MAX} characters).`;
  return undefined;
}

/** `/loop …` as typed; undefined for any other message. */
export function parseLoopCommand(text: string): ScheduleCommand | undefined {
  const m = text.trim().match(/^\/loop(?:\s+([\s\S]*))?$/i);
  if (!m) return undefined;
  const rest = (m[1] ?? "").trim();
  if (!rest || /^(list|status)$/i.test(rest)) return { cmd: "list", kind: "loop" };
  const stop = rest.match(/^(?:stop|cancel|delete)(?:\s+(\S+))?$/i);
  if (stop) {
    if (!stop[1] || /^all$/i.test(stop[1])) return { cmd: "remove", kind: "loop", which: "all" };
    const n = Number(stop[1]);
    return Number.isInteger(n) && n > 0 ? { cmd: "remove", kind: "loop", which: n } : { cmd: "error", text: `"${stop[1]}" isn't a loop number. /loop list shows them.` };
  }
  const words = rest.split(/\s+/);
  let i = /^every$/i.test(words[0]!) ? 1 : 0;
  const every = words[i] ? parseInterval(words[i]!) : undefined;
  if (!every) return { cmd: "error", text: `"${words[i] ?? ""}" isn't an interval. ${LOOP_USAGE}` };
  if (every < MIN_LOOP_MS) return { cmd: "error", text: "A loop runs at most once a minute." };
  i++;
  const prompt = rest.replace(new RegExp(`^(?:\\S+\\s+){${i}}`), "").trim();
  const bad = checkPrompt(i >= words.length ? "" : prompt, LOOP_USAGE);
  if (bad) return { cmd: "error", text: bad };
  return { cmd: "add", kind: "loop", prompt, everyMs: every, label: `every ${fmtInterval(every)}` };
}

/** `/schedule …` as typed; undefined for any other message. */
export function parseScheduleCommand(text: string, now = Date.now()): ScheduleCommand | undefined {
  const m = text.trim().match(/^\/schedule(?:\s+([\s\S]*))?$/i);
  if (!m) return undefined;
  const rest = (m[1] ?? "").trim();
  if (!rest || /^(list|status)$/i.test(rest)) return { cmd: "list", kind: "schedule" };
  const del = rest.match(/^(?:delete|remove|stop|cancel)(?:\s+(\S+))?$/i);
  if (del) {
    if (!del[1]) return { cmd: "error", text: "Say which schedule: /schedule delete <n> (/schedule list shows them), or /schedule delete all." };
    if (/^all$/i.test(del[1])) return { cmd: "remove", kind: "schedule", which: "all" };
    const n = Number(del[1]);
    return Number.isInteger(n) && n > 0 ? { cmd: "remove", kind: "schedule", which: n } : { cmd: "error", text: `"${del[1]}" isn't a schedule number. /schedule list shows them.` };
  }
  const words = rest.split(/\s+/);
  const after = (n: number) => rest.replace(new RegExp(`^(?:\\S+\\s+){${n}}`), "").trim();
  const done = (n: number, c: Omit<Extract<ScheduleCommand, { cmd: "add" }>, "cmd" | "prompt">): ScheduleCommand => {
    const prompt = n >= words.length ? "" : after(n);
    const bad = checkPrompt(prompt, SCHEDULE_USAGE);
    return bad ? { cmd: "error", text: bad } : { cmd: "add", prompt, ...c };
  };
  const w0 = words[0]!.toLowerCase();
  if (w0 === "at") {
    const at = parseAt(words.slice(1), now);
    if (!at) return { cmd: "error", text: `"${words.slice(1, 3).join(" ")}" isn't a time I understand (15:00, 3pm, tomorrow 9am, 2026-10-12 09:00). ${SCHEDULE_USAGE}` };
    if ("error" in at) return { cmd: "error", text: at.error };
    return done(1 + at.used, { kind: "once", at: at.at, label: `at ${words.slice(1, 1 + at.used).join(" ")}` });
  }
  if (w0 === "in") {
    const ms = words[1] ? parseInterval(words[1]) : undefined;
    if (!ms) return { cmd: "error", text: `"${words[1] ?? ""}" isn't a duration (30m, 2h, 1d). ${SCHEDULE_USAGE}` };
    return done(2, { kind: "once", at: now + ms, label: `in ${fmtInterval(ms)}` });
  }
  if (w0.startsWith("@")) {
    const c = parseCron(w0);
    if (typeof c === "string") return { cmd: "error", text: `${c} ${SCHEDULE_USAGE}` };
    return done(1, { kind: "cron", cron: w0, label: w0 });
  }
  // Five cron fields, optionally in quotes.
  const quoted = rest.match(/^["']([^"']+)["']\s*([\s\S]*)$/);
  const expr = quoted ? quoted[1]!.trim() : words.slice(0, 5).join(" ");
  const c = parseCron(expr);
  if (typeof c === "string") return { cmd: "error", text: words.length < 6 && !quoted ? `Say when, then what to send. ${SCHEDULE_USAGE}` : `${c} ${SCHEDULE_USAGE}` };
  if (nextCron(c, now) === undefined) return { cmd: "error", text: `"${expr}" never runs.` };
  if (quoted) {
    const bad = checkPrompt(quoted[2]!.trim(), SCHEDULE_USAGE);
    return bad ? { cmd: "error", text: bad } : { cmd: "add", kind: "cron", cron: expr, label: expr, prompt: quoted[2]!.trim() };
  }
  return done(5, { kind: "cron", cron: expr, label: expr });
}

/** Either command; undefined for any other message. */
export function parseTimerCommand(text: string, now = Date.now()): ScheduleCommand | undefined {
  return parseLoopCommand(text) ?? parseScheduleCommand(text, now);
}

// ---------------- state ----------------

/** A new loop or schedule from a parsed `add`. A loop's first run is now. */
export function newSchedule(c: Extract<ScheduleCommand, { cmd: "add" }>, now = Date.now()): SessionSchedule | undefined {
  let nextAt: number | undefined;
  if (c.kind === "loop") nextAt = now;
  else if (c.kind === "once") nextAt = c.at;
  else {
    const cron = parseCron(c.cron!);
    nextAt = typeof cron === "string" ? undefined : nextCron(cron, now);
  }
  if (nextAt === undefined) return undefined;
  return {
    id: crypto.randomUUID(),
    kind: c.kind,
    prompt: c.prompt,
    ...(c.everyMs ? { everyMs: c.everyMs } : {}),
    ...(c.cron ? { cron: c.cron } : {}),
    label: c.label,
    nextAt,
    runs: 0,
    createdAt: now,
  };
}

/**
 * After a run at `now`: the schedule with its next run, or undefined when it's over (a one-off, or
 * a cron that never matches again). Runs missed meanwhile (the runner was down, the session busy)
 * are skipped, not caught up: a loop keeps its cadence from its first run.
 */
export function advance(s: SessionSchedule, now = Date.now()): SessionSchedule | undefined {
  const ran = { ...s, lastRunAt: now, runs: s.runs + 1 };
  if (s.kind === "once") return undefined;
  if (s.kind === "loop") {
    const every = Math.max(MIN_LOOP_MS, s.everyMs ?? MIN_LOOP_MS);
    const k = Math.max(1, Math.floor((now - s.nextAt) / every) + 1);
    return { ...ran, nextAt: s.nextAt + k * every };
  }
  const cron = parseCron(s.cron ?? "");
  const next = typeof cron === "string" ? undefined : nextCron(cron, now);
  return next === undefined ? undefined : { ...ran, nextAt: next };
}

/** Loops, or schedules (cron and one-off), in the order /loop list and /schedule list number them. */
export function ofKind(list: SessionSchedule[], kind: "loop" | "schedule"): SessionSchedule[] {
  return list.filter((s) => (kind === "loop" ? s.kind === "loop" : s.kind !== "loop")).sort((a, b) => a.createdAt - b.createdAt);
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};

/** One line: `Every 10m: check CI… Next 14:20.` */
export function describeOne(s: SessionSchedule, now = Date.now()): string {
  const what = s.kind === "loop" ? `Every ${s.label.replace(/^every /, "")}` : s.kind === "cron" ? `${s.label}` : s.label[0]!.toUpperCase() + s.label.slice(1);
  const runs = s.runs ? ` Ran ${s.runs} time${s.runs === 1 ? "" : "s"}.` : "";
  return `${what}: ${clip(s.prompt, 120)} Next ${fmtWhen(s.nextAt, now)}.${runs}`;
}

/** What /loop list and /schedule list show. */
export function describeList(list: SessionSchedule[], kind: "loop" | "schedule", now = Date.now()): string {
  const mine = ofKind(list, kind);
  if (!mine.length)
    return kind === "loop" ? "No loops. Start one with /loop <interval> <prompt>, for example /loop 10m check CI and fix failures." : `No schedules. ${SCHEDULE_USAGE}`;
  const head = kind === "loop" ? "Loops (/loop stop <n> ends one):" : "Schedules (/schedule delete <n> removes one):";
  return [head, ...mine.map((s, i) => `${i + 1}. ${describeOne(s, now)}`)].join("\n");
}

// ---------------- the runner-wide timer ----------------

export interface ScheduledSession {
  sessionId: string;
  projectPath?: string;
  schedules: SessionSchedule[];
}

export interface SchedulerOptions {
  /** every session's loops and schedules: live sessions' state, stored prefs for the rest */
  list: () => ScheduledSession[];
  /** a run is due: open the session if needed and run it (session.runSchedule) */
  fire: (sessionId: string, scheduleId: string, projectPath?: string) => Promise<void>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/**
 * One timer for the whole runner, armed for the soonest run of any session (re-checked at least
 * hourly, so a clock change or a sleeping machine can't strand it). A run whose fire didn't move
 * it on (the session couldn't be opened, say) is tried again after RETRY_MS, not in a tight loop.
 */
export class Scheduler {
  static RETRY_MS = 5 * 60_000;
  static MAX_WAIT_MS = 60 * 60_000;
  private timer: unknown;
  private now: () => number;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (t: unknown) => void;
  /** session \n schedule -> the run time that was fired, and when */
  private tried = new Map<string, { nextAt: number; at: number }>();
  private ticking = false;
  private stopped = false;

  constructor(private o: SchedulerOptions) {
    this.now = o.now ?? Date.now;
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** When this run is next due: its time, or later if it was fired already and didn't move on. */
  private dueAt(sessionId: string, s: SessionSchedule): number {
    const t = this.tried.get(`${sessionId}\n${s.id}`);
    return t && t.nextAt === s.nextAt ? Math.max(s.nextAt, t.at + Scheduler.RETRY_MS) : s.nextAt;
  }

  /** Something changed (a schedule added, run, moved or removed): re-arm. */
  poke() {
    if (this.stopped) return;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    if (this.ticking) return; // tick() re-arms when it's done
    let soonest = Infinity;
    for (const x of this.o.list()) for (const s of x.schedules) soonest = Math.min(soonest, this.dueAt(x.sessionId, s));
    if (soonest === Infinity) return;
    const wait = Math.min(Math.max(0, soonest - this.now()), Scheduler.MAX_WAIT_MS);
    this.timer = this.setTimer(() => void this.tick(), wait);
  }

  /** Fires every run that's due, one at a time, then re-arms. */
  async tick() {
    this.timer = undefined;
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const now = this.now();
      const due: { x: ScheduledSession; s: SessionSchedule }[] = [];
      const keys = new Set<string>();
      for (const x of this.o.list())
        for (const s of x.schedules) {
          keys.add(`${x.sessionId}\n${s.id}`);
          if (this.dueAt(x.sessionId, s) <= now) due.push({ x, s });
        }
      for (const k of this.tried.keys()) if (!keys.has(k)) this.tried.delete(k);
      due.sort((a, b) => bySoonest(a.s, b.s));
      for (const { x, s } of due) {
        this.tried.set(`${x.sessionId}\n${s.id}`, { nextAt: s.nextAt, at: now });
        try {
          await this.o.fire(x.sessionId, s.id, x.projectPath);
        } catch (e: any) {
          console.error(`schedule: could not run ${kindLabel(s).toLowerCase()} "${clip(s.prompt, 60)}" in ${x.sessionId}: ${e?.message ?? e}`);
        }
      }
    } finally {
      this.ticking = false;
      this.poke();
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }
}

/** What sessionScheduler needs of a live session (session.ts LiveSession). */
interface RunsSchedules {
  id: string;
  closed: boolean;
  schedules: SessionSchedule[];
  runSchedule(id: string, now?: number): boolean;
}

/**
 * The runner's Scheduler over its sessions: live ones from their state, the rest from their
 * stored prefs (a session handed off has none left). A run due in a closed session opens it
 * (`open`, the runner's getLive) unless `openClosed` is false (TETHER_NO_RESUME: a second runner
 * never takes over stored sessions); a run that can't be delivered is skipped, and the stored
 * schedule moves on to its next run.
 */
export function sessionScheduler(o: {
  live: () => Iterable<RunsSchedules>;
  stored: () => Record<string, { schedules?: SessionSchedule[]; projectPath?: string; handoffTo?: unknown }>;
  /** sessions marked done: their runs wait until they're back (scheduleChanged on either change) */
  archived?: () => string[];
  open: (sessionId: string, projectPath?: string) => Promise<RunsSchedules>;
  save: () => void;
  openClosed?: boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): Scheduler {
  const now = o.now ?? Date.now;
  const liveNow = () => {
    const m = new Map<string, RunsSchedules>();
    for (const s of o.live()) if (!s.closed) m.set(s.id, s);
    return m;
  };
  const skip = (sessionId: string, id: string) => {
    const p = o.stored()[sessionId];
    const s = p?.schedules?.find((x) => x.id === id);
    if (!p || !s) return;
    const next = advance(s, now());
    p.schedules = p.schedules!.flatMap((x) => (x.id !== id ? [x] : next ? [next] : []));
    if (!p.schedules.length) p.schedules = undefined;
    o.save();
  };
  return new Scheduler({
    now,
    setTimer: o.setTimer,
    clearTimer: o.clearTimer,
    list: () => {
      const live = liveNow();
      const archived = new Set(o.archived?.() ?? []);
      const out: ScheduledSession[] = [];
      for (const s of live.values()) if (s.schedules.length && !archived.has(s.id)) out.push({ sessionId: s.id, schedules: s.schedules });
      for (const [id, p] of Object.entries(o.stored()))
        if (!live.has(id) && !archived.has(id) && p.schedules?.length && !p.handoffTo) out.push({ sessionId: id, projectPath: p.projectPath, schedules: p.schedules });
      return out;
    },
    fire: async (sessionId, id, projectPath) => {
      let s = liveNow().get(sessionId);
      if (!s && o.openClosed === false) return skip(sessionId, id);
      try {
        s ??= await o.open(sessionId, projectPath);
      } catch (e) {
        skip(sessionId, id);
        throw e;
      }
      s.runSchedule(id, now());
    },
  });
}

/** The runner's scheduler, told about changes by sessions (scheduleChanged). Set by index.ts. */
let current: Scheduler | undefined;
export function setScheduler(s: Scheduler | undefined) {
  current?.stop();
  current = s;
  s?.poke();
}
export function scheduleChanged() {
  current?.poke();
}
