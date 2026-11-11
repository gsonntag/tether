// Recovery belongs to the runner, so closing a browser never loses a retry or starts another.
import { randomUUID } from "node:crypto";
import type { RetryState } from "../../../shared/transcript";
import type { Session } from "./session";
import type { SessionCore } from "./sessions";
import { isSavedRetry, RETRY_DEADLINE_MS, RETRY_MAX_ATTEMPTS, retryTime, type SavedRetry } from "./retryPolicy";

interface RetryHost {
  identity(s: Session): { fingerprint: string; scope: string };
  blocked(s: Session): boolean;
  revision(s: Session): string | undefined;
  send(s: Session, retry: SavedRetry): Promise<void>;
}

export class RetryControl {
  private cooldowns = new Map<string, number>();
  private stopping = false;
  /** Injectable clock-independent policy for fast integration tests. */
  time = retryTime;
  gapMs = 1000;

  constructor(private core: SessionCore, private host: RetryHost) {}

  recover(s: Session, hit: { retryAt?: number }, sent: Session["lastSend"], error: string): boolean {
    if (this.stopping || !sent || s.retrySuppressed || s.stopped || s.turnActed || s.limitHit || s.summary.parentSessionId || this.host.blocked(s) || s.driver?.busy() || s.shellsRunning) return false;
    const now = this.core.now();
    const identity = this.host.identity(s);
    const old = s.retry;
    if (old && (old.phase !== "sending" || old.fingerprint !== identity.fingerprint)) return false;
    const deadline = old?.deadline ?? now + RETRY_DEADLINE_MS;
    const attempt = (old?.attempt ?? 0) + 1;
    const minAt = Math.max(now, Number.isFinite(hit.retryAt) ? hit.retryAt! : now);
    for (const [scope, at] of this.cooldowns) if (at <= now) this.cooldowns.delete(scope);
    const shared = this.cooldowns.get(identity.scope) ?? 0;
    const nextAt = this.time(attempt, now, deadline, Math.max(minAt, shared));
    if (attempt > (old?.maxAttempts ?? RETRY_MAX_ATTEMPTS) || nextAt === undefined) return false;
    const retry: SavedRetry = {
      id: old?.id ?? randomUUID(), attempt, maxAttempts: old?.maxAttempts ?? RETRY_MAX_ATTEMPTS,
      nextAt, deadline, minAt, error: error.slice(0, 4096), phase: "waiting",
      ...sent, ...identity, storeRevision: this.host.revision(s),
    };
    this.cooldowns.set(retry.scope, nextAt);
    s.retry = retry;
    this.save(s);
    s.apply({ type: "msg", msg: {
      id: `n-retry-${retry.id}`, role: "notice", level: "info", ts: now,
      parts: [{ type: "text", text: `Rate limited. Tether will retry automatically (attempt ${attempt}/${retry.maxAttempts}).` }],
    } });
    this.arm(s);
    return true;
  }

  /** Clear the chain before a user action or a final turn result; invalidate stale timers too. */
  clear(s: Session) {
    clearTimeout(s.retryTimer);
    s.retryTimer = undefined;
    s.retry = undefined;
    s.rateHit = undefined;
    this.core.o.prefs.set(s.id, { retry: undefined });
    this.core.o.prefs.flush();
    s.setState({ retry: undefined });
    this.core.touch(s);
  }

  async now(s: Session) {
    const r = s.retry;
    if (!r || r.phase !== "waiting") throw new Error("No retry is waiting.");
    // Retry now skips our backoff, but never a provider's requested minimum or another session's wait.
    const other = [...this.core.sessions.values()].some((x) => x !== s && x.retry?.scope === r.scope);
    const nextAt = Math.max(this.core.now(), r.minAt ?? 0, other ? this.cooldowns.get(r.scope) ?? 0 : 0);
    if (nextAt >= r.deadline) return this.fail(s, "The rate limit retry deadline was reached.");
    r.nextAt = nextAt;
    if (!other) this.cooldowns.set(r.scope, nextAt);
    this.save(s);
    this.arm(s);
  }

  /** Waiting is safe to restore. A request that may already have gone out is never replayed. */
  restore(s: Session, saved: unknown): boolean {
    if (!isSavedRetry(saved) || saved.phase !== "waiting" || saved.deadline <= this.core.now() || saved.deadline > this.core.now() + RETRY_DEADLINE_MS || this.host.blocked(s) || s.state.status !== "idle" || s.driver?.busy() || saved.fingerprint !== this.host.identity(s).fingerprint || saved.scope !== this.host.identity(s).scope) return false;
    if (!s.capabilities.persistent && (!saved.storeRevision || saved.storeRevision !== this.host.revision(s))) return false;
    s.retry = { ...saved, attachments: [...saved.attachments] };
    this.cooldowns.set(saved.scope, Math.max(saved.nextAt, this.cooldowns.get(saved.scope) ?? 0));
    this.save(s);
    this.arm(s);
    return true;
  }

  stop() {
    this.stopping = true;
    for (const s of this.core.sessions.values()) clearTimeout(s.retryTimer);
  }

  private publicState(r: SavedRetry): RetryState {
    const { attempt, maxAttempts, nextAt, deadline, error } = r;
    return { attempt, maxAttempts, nextAt, deadline, error };
  }

  private save(s: Session) {
    const r = s.retry;
    if (!r) return;
    this.core.o.prefs.set(s.id, { projectPath: s.summary.projectPath, retry: r });
    this.core.o.prefs.flush();
    s.setState({ retry: r.phase === "waiting" ? this.publicState(r) : undefined });
    this.core.touch(s);
  }

  private arm(s: Session) {
    clearTimeout(s.retryTimer);
    const r = s.retry;
    if (!r || this.stopping) return;
    s.retryTimer = setTimeout(() => void this.run(s, r), Math.max(0, r.nextAt - this.core.now()));
    s.retryTimer.unref?.();
  }

  private async run(s: Session, r: SavedRetry) {
    if (this.stopping || s.retry !== r || r.phase !== "waiting") return;
    if (this.core.now() >= r.deadline) return this.fail(s, "The rate limit retry deadline was reached.");
    if (this.host.blocked(s) || s.state.status !== "idle" || s.driver?.busy() || r.fingerprint !== this.host.identity(s).fingerprint) return this.fail(s, "The session changed while a rate limit retry was waiting. Send a message to continue.");
    // A harness may finish its turn before the send promise resolves. Do not race that send.
    if (s.sending || s.starting) {
      s.retryTimer = setTimeout(() => void this.run(s, r), 25);
      s.retryTimer.unref?.();
      return;
    }
    // Spread simultaneous recoveries on the same provider/model. Each reservation moves the
    // next session beyond this one; never let Retry now bypass a provider's requested wait.
    const earliest = Math.max(r.minAt ?? 0, this.cooldowns.get(r.scope) ?? 0);
    if (earliest > this.core.now()) {
      if (earliest >= r.deadline) return this.fail(s, "The rate limit retry deadline was reached.");
      r.nextAt = earliest;
      this.save(s);
      return this.arm(s);
    }
    this.cooldowns.set(r.scope, this.core.now() + this.gapMs);
    r.phase = "sending";
    this.save(s); // Persist before dispatch: a crash now must not resend an uncertain request.
    try {
      await this.host.send(s, r);
    } catch {
      // LiveControl reports a rejected send and either recovers it or ends the chain.
      if (s.retry === r) this.fail(s, "The rate limit retry could not be sent. Send a message to continue.");
    }
  }

  private fail(s: Session, error: string) {
    this.clear(s);
    s.setState({ error });
    s.apply({ type: "msg", msg: { id: `n-${randomUUID()}`, role: "notice", level: "error", ts: this.core.now(), parts: [{ type: "text", text: error }] } });
    this.core.o.bus.emit("turnEnded", { sessionId: s.id, error });
  }
}
