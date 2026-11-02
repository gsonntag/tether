import { expect, test } from "bun:test";
import { rateLimitHit, safeRetryAt } from "./rateLimit";

test("retry timing accepts future delta seconds and HTTP dates only", () => {
  expect(safeRetryAt("12", 1000)).toBe(13000);
  expect(safeRetryAt("Thu, 01 Jan 1970 00:00:13 GMT", 1000)).toBe(13000);
  expect(safeRetryAt("0", 1000)).toBeUndefined();
  expect(safeRetryAt("junk", 1000)).toBeUndefined();
});

test("classifies structured rate limits and HTTP 429 retry wrappers", () => {
  expect(rateLimitHit({ codexErrorInfo: "rateLimitExceeded" })).toEqual({});
  expect(rateLimitHit({ response: { status: 429 }, retryAfter: "5" }, 1000)).toEqual({ retryAt: 6000 });
  expect(rateLimitHit({ status: 429, retryAfter: 5 }, 1000)).toEqual({ retryAt: 6000 });
  expect(rateLimitHit({ codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } })).toEqual({});
  expect(rateLimitHit({ codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 502 } } })).toBeUndefined();
  expect(rateLimitHit({ codexErrorInfo: "responseTooManyFailedAttempts" })).toBeUndefined();
  expect(rateLimitHit({ codexErrorInfo: "serverOverloaded", status: 429 })).toBeUndefined();
  expect(rateLimitHit({ headers: { "retry-after-ms": "2500" } , status: 429 }, 1000)).toEqual({ retryAt: 3500 });
});

test("matches the narrow token rate message across model and region names", () => {
  expect(rateLimitHit({ message: "rate limit exceeded: Your requests to gpt-6-luna for gpt-6-luna in eastus have exceeded token rate limit." })).toEqual({});
  expect(rateLimitHit({ message: "rate limit exceeded: Your requests to azure-prod/model-17 for deployment_4 in west-europe have exceeded token rate limit." })).toEqual({});
  expect(rateLimitHit({ message: "Token rate limit exceeded for another model." })).toBeUndefined();
});

test("explicit quota and authentication codes override transient signals", () => {
  expect(rateLimitHit({ codexErrorInfo: "usageLimitExceeded", status: 429 })).toBeUndefined();
  expect(rateLimitHit({ codexErrorInfo: "unauthorized", message: "rate limit exceeded: Your requests to gpt-6-luna for gpt-6-luna in eastus have exceeded token rate limit." })).toBeUndefined();
  expect(rateLimitHit({ status: 429, error: { code: "insufficient_quota" } })).toBeUndefined();
  expect(rateLimitHit({ codexErrorInfo: "serverOverloaded", message: "rate limit exceeded: Your requests to gpt-6-luna for gpt-6-luna in eastus have exceeded token rate limit." })).toBeUndefined();
  expect(rateLimitHit({ codexErrorInfo: { serverOverloaded: true }, message: "rate limit exceeded: Your requests to gpt-6-luna for gpt-6-luna in eastus have exceeded token rate limit." })).toBeUndefined();
  expect(rateLimitHit({ code: "api_error", message: "rate limit exceeded: Your requests to gpt-6-luna for gpt-6-luna in eastus have exceeded token rate limit." })).toEqual({});
  expect(rateLimitHit({ codexErrorInfo: "other", message: "rate limit exceeded: Your requests to gpt-6-luna for gpt-6-luna in eastus have exceeded token rate limit." })).toEqual({});
  expect(rateLimitHit({ codexErrorInfo: { usageLimitExceeded: {} }, status: 429 })).toBeUndefined();
});
