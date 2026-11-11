import { describe, expect, test } from "bun:test";
import { ATTACH_FILE_MAX, ATTACH_MAX, MESSAGE_TEXT_MAX } from "../../../shared/limits";
import type { Attachment } from "../../../shared/attachments";
import { isSavedRetry, RETRY_DEADLINE_MS, RETRY_DELAYS_MS, RETRY_MAX_ATTEMPTS, retryTime, type SavedRetry } from "./retryPolicy";

describe("retry policy", () => {
  test("uses the configured exponential delays with bounded ±20% jitter", () => {
    expect(RETRY_DELAYS_MS).toEqual([15_000, 30_000, 60_000, 120_000, 120_000]);
    expect(RETRY_MAX_ATTEMPTS).toBe(5);
    expect(RETRY_DEADLINE_MS).toBe(600_000);
    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      const base = RETRY_DELAYS_MS[attempt - 1]!;
      expect(retryTime(attempt, 10_000, 600_000, undefined, () => 0)).toBe(10_000 + base * 0.8);
      expect(retryTime(attempt, 10_000, 600_000, undefined, () => 0.5)).toBe(10_000 + base);
      expect(retryTime(attempt, 10_000, 600_000, undefined, () => 1)).toBe(10_000 + base * 1.2);
    }
  });

  test("keeps provider retry-after as a lower bound and rejects a retry at the deadline", () => {
    expect(retryTime(1, 1_000, 100_000, 50_000, () => 0.5)).toBe(50_000);
    expect(retryTime(1, 1_000, 100_000, 500, () => 0.5)).toBe(16_000);
    expect(retryTime(1, 1_000, 16_000, undefined, () => 0.5)).toBeUndefined();
    expect(retryTime(1, 1_000, 17_000, 17_000, () => 0)).toBeUndefined();
  });

  test("rejects invalid attempts, non-finite inputs, and invalid jitter samples", () => {
    for (const attempt of [0, -1, 1.5, 6, NaN, Infinity]) expect(retryTime(attempt, 0, 1_000, undefined, () => 0.5)).toBeUndefined();
    expect(retryTime(1, NaN, 1_000)).toBeUndefined();
    expect(retryTime(1, 0, Infinity)).toBeUndefined();
    expect(retryTime(1, 0, 1_000, NaN)).toBeUndefined();
    expect(retryTime(1, 0, 1_000, undefined, () => -0.1)).toBeUndefined();
    expect(retryTime(1, 0, 1_000, undefined, () => 1.1)).toBeUndefined();
  });
});

const attachment: Attachment = { path: "/tmp/attachments/abc-file.txt", name: "file.txt", mimeType: "text/plain", size: 20 };
const saved: SavedRetry = {
  id: "chain-id",
  attempt: 1,
  maxAttempts: 5,
  nextAt: 20_000,
  deadline: 600_000,
  error: "rate limited",
  minAt: 18_000,
  phase: "waiting",
  text: "hello",
  attachments: [attachment],
  tether: true,
  fingerprint: "fingerprint-v1",
  scope: "claude:session",
};

describe("saved retry validation", () => {
  test("accepts a well-formed saved retry with or without optional fields", () => {
    expect(isSavedRetry(saved)).toBe(true);
    const { minAt: _minAt, tether: _tether, ...withoutOptional } = saved;
    expect(isSavedRetry(withoutOptional)).toBe(true);
  });

  test("rejects corrupt timing, attempts, phases, and oversized message data", () => {
    const cases: unknown[] = [
      { ...saved, attempt: 0 },
      { ...saved, attempt: 6 },
      { ...saved, maxAttempts: 6 },
      { ...saved, nextAt: saved.deadline },
      { ...saved, deadline: NaN },
      { ...saved, deadline: saved.nextAt + RETRY_DEADLINE_MS + 1 },
      { ...saved, minAt: saved.nextAt + 1 },
      { ...saved, phase: "queued" },
      { ...saved, text: "x".repeat(MESSAGE_TEXT_MAX + 1) },
      { ...saved, text: "", attachments: [] },
      { ...saved, attachments: Array.from({ length: ATTACH_MAX + 1 }, () => attachment) },
    ];
    for (const value of cases) expect(isSavedRetry(value)).toBe(false);
  });

  test("rejects malformed attachment metadata before a saved retry can send", () => {
    expect(isSavedRetry({ ...saved, attachments: [{ ...attachment, size: 0 }] })).toBe(true);
    const cases = [
      { ...attachment, path: "relative/file.txt" },
      { ...attachment, path: "/tmp/file\n.txt" },
      { ...attachment, name: "../file.txt" },
      { ...attachment, mimeType: "not-a-mime" },
      { ...attachment, size: ATTACH_FILE_MAX + 1 },
    ];
    for (const bad of cases) expect(isSavedRetry({ ...saved, attachments: [bad] })).toBe(false);
  });
});
