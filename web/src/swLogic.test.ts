import { expect, test } from "bun:test";
// @ts-ignore: a classic script for the service worker, also exported for tests
import sw from "../public/swLogic.js";
import { presenceFor } from "./route";

const { tetherUrlFor, tetherNotification, tetherOnScreen, tetherPickClient } = sw as any;

test("a notification links to its session", () => {
  expect(tetherUrlFor({ runnerId: "box 1", sessionId: "claude:a/b" }, "https://t.dev")).toBe("https://t.dev/#/s/box%201/claude%3Aa%2Fb");
  expect(tetherUrlFor({ kind: "test" }, "https://t.dev")).toBe("https://t.dev/#/");
});

test("what a notification says", () => {
  expect(tetherNotification({ kind: "request", title: "Fix it", body: "Claude wants to run ls", tag: "req-1", ts: 5 })).toMatchObject({ title: "Needs you · Fix it", options: { body: "Claude wants to run ls", tag: "req-1", renotify: true, timestamp: 5 } });
  expect(tetherNotification({ kind: "failed", title: "Fix it", body: "Failed: rate limited." })).toMatchObject({ title: "Fix it", options: { body: "Failed: rate limited." } });
  expect(tetherNotification({ kind: "finished", title: "Fix it" }).title).toBe("Fix it");
});

test("a window already showing the session (focused) gets no notification; a click goes to that window, else any", () => {
  const url = "https://t.dev/#/s/r/s";
  const a = { url, focused: true, visibilityState: "visible" };
  const b = { url: "https://t.dev/#/", focused: false, visibilityState: "hidden" };
  expect(tetherOnScreen([a], url)).toBe(true);
  expect(tetherOnScreen([{ ...a, focused: false }], url)).toBe(false);
  expect(tetherOnScreen([b], url)).toBe(false);
  expect(tetherPickClient([b, a], url)).toBe(a);
  expect(tetherPickClient([b], url)).toBe(b);
  expect(tetherPickClient([], url)).toBeNull();
});

test("presence: a session while the page is visible, else nothing", () => {
  expect(presenceFor("#/s/r1/claude%3Ax", true)).toEqual({ runnerId: "r1", sessionId: "claude:x" });
  expect(presenceFor("#/s/r1/claude%3Ax", false)).toEqual({});
  expect(presenceFor("#/", true)).toEqual({});
});
