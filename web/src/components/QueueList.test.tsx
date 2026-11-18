import { afterAll, beforeAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LiveState, Msg, QueuedMessage } from "../../../shared/transcript";

(globalThis as any).location ??= { protocol: "http:", host: "localhost" };
(globalThis as any).document ??= { addEventListener() {}, visibilityState: "visible" };
(globalThis as any).window ??= { addEventListener() {} };
(globalThis as any).requestAnimationFrame ??= () => 0;
const { QueueList } = await import("./QueueList");
const { Message } = await import("./Message");

let tz: string | undefined;
beforeAll(() => {
  tz = process.env.TZ;
  process.env.TZ = "America/New_York";
});
afterAll(() => {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
});

const state = (queue: QueuedMessage[], o: Partial<LiveState> = {}) => ({ mode: "live", status: "idle", requests: [], queue, ...o }) as LiveState;
const html = (s: LiveState) => renderToStaticMarkup(<QueueList runnerId="r" sessionId="claude:s" state={s} />);
const soon = Date.now() + 2 * 60 * 60 * 1000;

test("scheduled messages are a group of their own, with their time; the head counts the rest", () => {
  const out = html(state([{ id: "a", text: "now-ish", queuedAt: 1 }, { id: "b", text: "later on", queuedAt: 1, at: soon }], { queueHeld: true, queueHeldBy: "stopped" }));
  expect(out).toContain("1 message waits · Paused after Stop");
  expect(out).toContain("Scheduled");
  expect(out).toMatch(/Sends (at|tomorrow at) /);
  expect(out).toContain("later on");
  expect(out).toContain('aria-label="Send now"');
});

test("only scheduled: no head, no Resume", () => {
  const out = html(state([{ id: "b", text: "later on", queuedAt: 1, at: soon }]));
  expect(out).not.toContain("waits");
  expect(out).not.toContain("Resume");
  expect(out).toContain("later on");
});

test("one that waits for you says why", () => {
  expect(html(state([{ id: "b", text: "x", queuedAt: 1, at: Date.now() - 2 * 86400_000, held: "late" }]))).toContain("Not sent: the runner was off for more than a day after its time.");
  expect(html(state([{ id: "b", text: "x", queuedAt: 1, at: Date.now() - 1000 }]))).toContain("goes when the session is free");
  expect(html(state([{ id: "b", text: "x", queuedAt: 1, at: Date.now() - 1000, asap: true }]))).toContain("Sending now");
  expect(html(state([{ id: "b", text: "x", queuedAt: 1, at: Date.now() - 1000, held: "stopped" }]))).toContain("you pressed Stop while it was due");
});

test("the late notice says when it was for and when it went, in local time", () => {
  const ts = new Date("2026-11-18T21:14:00-05:00").getTime();
  const msg: Msg = { id: "n-late-1", role: "notice", level: "info", ts, scheduledFor: new Date("2026-11-18T21:00:00-05:00").getTime(), parts: [{ type: "text", text: "Scheduled message sent late." }] };
  const out = renderToStaticMarkup(<Message msg={msg} />);
  expect(out).toContain("Scheduled message sent late. It was for 9:00 PM; sent at 9:14 PM.");
});
