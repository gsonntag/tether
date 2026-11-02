/** A retry time in milliseconds since epoch, accepted only when it is finite and in the future. */
export function safeRetryAt(value: unknown, now = Date.now()): number | undefined {
  let at: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) at = value;
  else if (typeof value === "string" && value.trim()) {
    const s = value.trim();
    // Retry-After permits either delta-seconds or an HTTP date.
    if (/^\d+(?:\.\d+)?$/.test(s)) at = now + Number(s) * 1000;
    else { const parsed = Date.parse(s); if (Number.isFinite(parsed)) at = parsed; }
  }
  return at !== undefined && Number.isFinite(at) && at > now ? at : undefined;
}

const TOKEN_RATE_TEXT = /^rate limit exceeded: Your requests to [\w.:/-]{1,128} for [\w.:/-]{1,128} in [\w-]{1,64} have exceeded token rate limit\.$/i;
const fatalCodes = new Set(["usagelimitexceeded", "usage_limit_exceeded", "quotaexceeded", "quota_exceeded", "quota", "billing_hard_limit_reached", "insufficient_quota", "unauthorized", "authentication_error", "invalid_api_key"]);
const genericCodes = new Set(["", "other", "error", "api_error", "unknown", "unknown_error", "unrecognized", "server_error"]);
const rateCodes = new Set(["ratelimitexceeded", "rate_limit_exceeded", "rate_limit_error", "ratelimit"]);

function objects(error: any, depth = 0, seen = new Set<object>()): any[] {
  if (!error || typeof error !== "object" || depth > 6 || seen.has(error)) return [];
  seen.add(error);
  return [error, ...[error.error, error.cause, error.response?.data, error.data, error.codexErrorInfo].flatMap((x) => objects(x, depth + 1, seen))];
}

function codesOf(error: any): string[] {
  return [error.code, error.type, error.errorCode, error.name]
    .filter((x): x is string => typeof x === "string")
    .concat(typeof error.codexErrorInfo === "string" ? [error.codexErrorInfo] : []);
}

function hasFatalInfo(info: any): boolean {
  if (!info || typeof info !== "object") return false;
  return Object.keys(info).some((key) => fatalCodes.has(key.toLowerCase()));
}

function hasRateInfo(info: any): boolean {
  if (typeof info === "string") return rateCodes.has(info.replace(/[^\w]/g, "").toLowerCase()) || rateCodes.has(info.toLowerCase());
  if (!info || typeof info !== "object") return false;
  if (info.rateLimitExceeded !== undefined || info.rate_limit_exceeded !== undefined) return true;
  const many = info.responseTooManyFailedAttempts ?? info.response_too_many_failed_attempts;
  return !!many && (many.httpStatusCode === 429 || many.http_status_code === 429 || many.status === 429);
}

function retryAtFrom(error: any, now: number): number | undefined {
  const direct = error.retryAt ?? error.retry_at;
  if (direct !== undefined) return safeRetryAt(direct, now);
  const header = error.retryAfter ?? error.retry_after ?? error.headers?.["retry-after"] ?? error.headers?.["Retry-After"];
  const at = safeRetryAt(typeof header === "number" ? String(header) : header, now);
  if (at) return at;
  const ms = error.retryAfterMs ?? error.retry_after_ms ?? error.headers?.["retry-after-ms"] ?? error.headers?.["Retry-After-Ms"];
  const delta = typeof ms === "number" ? ms : typeof ms === "string" && /^\d+(?:\.\d+)?$/.test(ms.trim()) ? Number(ms.trim()) : undefined;
  if (delta !== undefined && Number.isFinite(delta) && delta > 0) return now + delta;
  return undefined;
}

/** Classifies transient throttling only; explicit quota/auth/usage errors always take precedence. */
export function rateLimitHit(error: any, now = Date.now()): { retryAt?: number } | undefined {
  if (!error || typeof error !== "object") return undefined;
  const chain = objects(error);
  const allCodes = chain.flatMap(codesOf);
  // Fatal quota/auth/usage codes anywhere in a wrapper beat both an outer 429 and message fallback.
  if (allCodes.some((value) => fatalCodes.has(value.toLowerCase())) || chain.some((x) => hasFatalInfo(x.codexErrorInfo))) return undefined;
  const infos = chain.map((x) => x.codexErrorInfo);
  if (infos.some((info) => info !== undefined && info !== null && !hasRateInfo(info) && (typeof info !== "string" || !genericCodes.has(info.toLowerCase())))) return undefined;
  const structured = infos.some(hasRateInfo) || allCodes.some((c) => rateCodes.has(c.replace(/[^\w]/g, "").toLowerCase()) || rateCodes.has(c.toLowerCase()));
  const is429 = chain.some((x) => x.status === 429 || x.statusCode === 429 || x.httpStatus === 429 || x.httpStatusCode === 429 || x.response?.status === 429 || x.code === 429);
  const message = chain.map((x) => x.message).find((x) => typeof x === "string") ?? "";
  // Only absent or generic codes permit the narrow legacy provider message fallback.
  const generic = allCodes.every((c) => genericCodes.has(c.toLowerCase()));
  const unrecognizedInfo = chain.some((x) => {
    const info = x.codexErrorInfo;
    return info !== undefined && info !== null && !hasRateInfo(info) && (typeof info !== "string" || !genericCodes.has(info.toLowerCase()));
  });
  const fallback = generic && !unrecognizedInfo && TOKEN_RATE_TEXT.test(message.trim());
  if (!structured && !is429 && !fallback) return undefined;
  const retryAt = chain.map((x) => retryAtFrom(x, now)).find((x) => x !== undefined);
  return retryAt ? { retryAt } : {};
}
