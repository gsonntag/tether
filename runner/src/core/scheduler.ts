// One timer for every scheduled message (SPEC §9 Scheduled sends). Not one per message: a timer set
// for days overflows (Bun's, like Node's, fire at once past ~24.8 days), and a clock that jumps
// (a laptop waking, NTP) would leave them wrong. This one is set for the next time anything is due,
// and never for more than a minute: each time it fires it looks again at the clock and re-arms.

/** The longest the timer waits before looking again (clock jumps, a machine that slept). */
export const SCHEDULE_TICK_MS = 60_000;

export interface SchedulerHost {
  now(): number;
  /** the soonest time something is due; `now` or earlier: something due hasn't gone yet */
  next(): number | undefined;
  /** sends (or queues next) whatever is due */
  fire(): void;
  /** nothing is scheduled (any more) */
  idle?(): void;
}

export class Scheduler {
  private timer?: ReturnType<typeof setTimeout>;
  /** when the armed timer fires */
  private at?: number;
  /** the runner is stopping: never armed again */
  private off = false;

  constructor(
    private host: SchedulerHost,
    private timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
  ) {}

  /** Looks at what's scheduled again (call after any change): the timer is set for the next one. */
  arm() {
    if (this.off) return;
    const next = this.host.next();
    if (next === undefined) {
      this.host.idle?.();
      return this.stop();
    }
    const now = this.host.now();
    // Something due that couldn't go yet (the turn runs, the terminal drives): its own triggers send
    // it (a turn's end, Back to Tether); this only looks again in a while, in case one is missed.
    const wait = next <= now ? SCHEDULE_TICK_MS : Math.min(next - now, SCHEDULE_TICK_MS);
    const at = now + wait;
    // Already set for that time or sooner.
    if (this.timer && this.at !== undefined && this.at <= at && this.at > now) return;
    this.stop();
    this.at = at;
    this.timer = this.timers.set(() => this.tick(), wait);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** The timer fired (or a test's clock moved): what's due goes, and it's set again. */
  tick() {
    this.timer = undefined;
    this.at = undefined;
    try {
      this.host.fire();
    } finally {
      this.arm();
    }
  }

  /** For good (the runner stops). */
  halt() {
    this.off = true;
    this.stop();
  }

  stop() {
    if (this.timer) this.timers.clear(this.timer);
    this.timer = undefined;
    this.at = undefined;
  }
}

/** A gap this long between two looks at the clock was time the runner was off (or asleep). */
export const DOWN_GAP_MS = 5 * 60_000;

/**
 * When the runner was off (SPEC §9 Scheduled sends: a message is held for you only when the runner
 * was off for more than a day after its time, not when it waited behind a turn or the terminal).
 * The last time it was seen running is saved (runner.json `aliveAt`) while scheduled messages wait;
 * the time from then to this start, and any long gap between two looks (a machine asleep), was off.
 */
export class Uptime {
  /** the last look at the clock while something was scheduled; undefined: nothing is (gaps then aren't time off) */
  private last?: number;
  private saved?: number;
  private down: { from: number; to: number }[] = [];

  constructor(
    private now: () => number,
    private store: { get(): number | undefined; set(t: number | undefined): void },
  ) {
    // Saved only while something is scheduled (cleared when nothing is): from then to now was off.
    const was = store.get();
    const t = now();
    if (was !== undefined) {
      if (t - was > DOWN_GAP_MS) this.down.push({ from: was, to: t });
      this.last = t;
      this.saved = was;
    }
  }

  /** The runner is running now. `save`: written now (a message was just scheduled), else every few minutes. */
  seen(save = false) {
    const t = this.now();
    // A gap between two looks while something was scheduled: the machine slept, or the process stalled.
    if (this.last !== undefined && t - this.last > DOWN_GAP_MS) this.down = [...this.down, { from: this.last, to: t }].slice(-20);
    this.last = Math.max(this.last ?? t, t);
    if (save || this.saved === undefined || t - this.saved >= DOWN_GAP_MS) {
      this.saved = t;
      this.store.set(t);
    }
  }

  /** Nothing is scheduled: the time from now on isn't watched, and runner.json forgets `aliveAt`. */
  idle() {
    if (this.last === undefined && this.saved === undefined) return;
    this.last = this.saved = undefined;
    this.store.set(undefined);
  }

  /** How long the runner was off after `at`. */
  offSince(at: number): number {
    return this.down.reduce((n, d) => n + Math.max(0, d.to - Math.max(d.from, at)), 0);
  }
}
