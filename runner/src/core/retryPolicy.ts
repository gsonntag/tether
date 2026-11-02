import { ATTACH_FILE_MAX, ATTACH_IMAGE_MAX, ATTACH_MAX, MESSAGE_TEXT_MAX } from "../../../shared/limits";
import { NAME_BYTES_MAX, type Attachment } from "../../../shared/attachments";

/** Delays before the first five additional attempts, in milliseconds. */
export const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 120_000] as const;
export const RETRY_DEADLINE_MS = 600_000;
export const RETRY_MAX_ATTEMPTS = 5;

/**
 * Calculate an absolute retry time. `attempt` is the ordinal of the additional attempt (1..5).
 * A provider hint is a lower bound; callers can apply any other lower bounds themselves.
 */
export function retryTime(
  attempt: number,
  now: number,
  deadline: number,
  retryAt?: number,
  random: () => number = Math.random,
): number | undefined {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > RETRY_MAX_ATTEMPTS) return undefined;
  if (!Number.isFinite(now) || !Number.isFinite(deadline) || (retryAt !== undefined && !Number.isFinite(retryAt))) return undefined;
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) return undefined;
  const delay = Math.round(RETRY_DELAYS_MS[attempt - 1]! * (0.8 + sample * 0.4));
  const nextAt = Math.max(Math.ceil(now + delay), retryAt === undefined ? -Infinity : Math.ceil(retryAt));
  if (!Number.isFinite(nextAt) || nextAt >= deadline) return undefined;
  return nextAt;
}

export interface SavedRetry {
  id: string;
  attempt: number;
  maxAttempts: number;
  nextAt: number;
  deadline: number;
  error: string;
  minAt?: number;
  phase: "waiting" | "sending";
  text: string;
  attachments: Attachment[];
  tether?: boolean;
  fingerprint: string;
  scope: string;
  storeRevision?: string;
}

const isBoundedString = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === "string" && value.length <= max && (allowEmpty || value.length > 0);

function isAttachment(value: unknown): value is Attachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const a = value as Record<string, unknown>;
  if (!isBoundedString(a.path, 4096) || !a.path.startsWith("/") || /[\u0000-\u001f\u007f]/.test(a.path)) return false;
  if (!isBoundedString(a.name, NAME_BYTES_MAX) || /[\\/\u0000-\u001f\u007f]/.test(a.name)) return false;
  if (!isBoundedString(a.mimeType, 128) || !/^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*$/i.test(a.mimeType)) return false;
  if (typeof a.size !== "number" || !Number.isSafeInteger(a.size) || a.size < 0) return false;
  const max = a.mimeType.toLowerCase().startsWith("image/") ? ATTACH_IMAGE_MAX : ATTACH_FILE_MAX;
  return a.size <= max;
}

/** Validate persisted retry data before it is allowed to trigger a send after restart. */
export function isSavedRetry(value: unknown): value is SavedRetry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (!isBoundedString(r.id, 128) || !isBoundedString(r.fingerprint, 512) || !isBoundedString(r.scope, 512)) return false;
  if (r.storeRevision !== undefined && !isBoundedString(r.storeRevision, 256)) return false;
  if (!Number.isInteger(r.attempt) || (r.attempt as number) < 1) return false;
  if (!Number.isInteger(r.maxAttempts) || (r.maxAttempts as number) < 1 || (r.maxAttempts as number) > RETRY_MAX_ATTEMPTS || (r.attempt as number) > (r.maxAttempts as number)) return false;
  if (typeof r.nextAt !== "number" || !Number.isFinite(r.nextAt) || r.nextAt < 0) return false;
  if (typeof r.deadline !== "number" || !Number.isFinite(r.deadline) || r.deadline <= 0 || r.nextAt >= r.deadline || r.deadline - r.nextAt > RETRY_DEADLINE_MS) return false;
  if (r.minAt !== undefined && (typeof r.minAt !== "number" || !Number.isFinite(r.minAt) || r.minAt < 0 || r.minAt > r.nextAt)) return false;
  if (!isBoundedString(r.error, 4096, true)) return false;
  if (r.phase !== "waiting" && r.phase !== "sending") return false;
  if (!isBoundedString(r.text, MESSAGE_TEXT_MAX, true)) return false;
  if (!Array.isArray(r.attachments) || r.attachments.length > ATTACH_MAX || !r.attachments.every(isAttachment)) return false;
  if (!r.text.trim() && r.attachments.length === 0) return false;
  if (r.tether !== undefined && typeof r.tether !== "boolean") return false;
  return true;
}
