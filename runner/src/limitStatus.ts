// The "NN% of five_hour" status Claude sessions show from the SDK's rate_limit_event. One warning
// per limit window; a window's warning goes away when the window resets (resetsAt) or when a later
// event for it reports plain "allowed", and a newer event replaces it.

export interface RateLimitInfo {
  status?: "allowed" | "allowed_warning" | "rejected" | string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
}

/** Seconds or milliseconds since the epoch → milliseconds. */
export const toMs = (t: number) => (t < 1e12 ? t * 1000 : t);

export class LimitStatus {
  private windows = new Map<string, { pct: number; resetAt?: number }>();

  /** Applies one event; returns true when the status text may have changed. */
  update(info: RateLimitInfo | undefined, now = Date.now()): boolean {
    if (!info) return false;
    const type = info.rateLimitType ?? "limit";
    if (info.status === "allowed_warning" && typeof info.utilization === "number") {
      this.windows.set(type, { pct: Math.round(info.utilization * 100), resetAt: info.resetsAt ? toMs(info.resetsAt) : undefined });
      this.expire(now);
      return true;
    }
    if (info.status === "allowed") {
      // No warning: this window is fine again (an untyped "allowed" clears them all).
      if (info.rateLimitType) return this.windows.delete(type);
      const had = this.windows.size > 0;
      this.windows.clear();
      return had;
    }
    return false;
  }

  /** Drops windows whose reset time has passed; true if any went. */
  expire(now = Date.now()): boolean {
    let changed = false;
    for (const [k, w] of this.windows)
      if (w.resetAt !== undefined && w.resetAt <= now) {
        this.windows.delete(k);
        changed = true;
      }
    return changed;
  }

  /** The most-used window, e.g. "83% of five_hour"; undefined when there is nothing to warn about. */
  text(): string | undefined {
    let best: [string, { pct: number }] | undefined;
    for (const e of this.windows) if (!best || e[1].pct > best[1].pct) best = e;
    return best ? `${best[1].pct}% of ${best[0]}` : undefined;
  }

  /** When the next window resets (for a timer), if any. */
  nextReset(): number | undefined {
    let t: number | undefined;
    for (const w of this.windows.values()) if (w.resetAt !== undefined && (t === undefined || w.resetAt < t)) t = w.resetAt;
    return t;
  }
}
