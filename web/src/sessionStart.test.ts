import { describe, expect, test } from "bun:test";
import { opensByStarting, processStarted } from "./sessionStart";

describe("sessions whose process isn't running", () => {
  test("only harnesses that can't show a stored conversation say they're starting on open", () => {
    expect(opensByStarting("kiro", false)).toBe(true);
    expect(opensByStarting("claude-code", false)).toBe(false);
    expect(opensByStarting("opencode", false)).toBe(false);
    expect(opensByStarting("kiro", true)).toBe(false);
    expect(opensByStarting("kiro", undefined)).toBe(false);
  });

  test("a process starting under an open session takes a fresh snapshot, once", () => {
    const closed = { loading: false, session: { live: false } };
    expect(processStarted(closed, { live: true })).toBe(true);
    expect(processStarted(closed, { live: false })).toBe(false);
    expect(processStarted({ ...closed, syncing: true }, { live: true })).toBe(false);
    expect(processStarted({ loading: true }, { live: true })).toBe(false);
    expect(processStarted({ loading: false, session: { live: true } }, { live: true })).toBe(false);
    expect(processStarted(undefined, { live: true })).toBe(false);
  });
});
