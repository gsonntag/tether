import { expect, test } from "bun:test";
import { EventBus } from "./bus";
import type { CoreEvents } from "./events";

test("listeners get typed payloads in order and can unsubscribe", () => {
  const bus = new EventBus<CoreEvents>();
  const seen: string[] = [];
  const off = bus.on("turnStarted", (e) => seen.push(`a:${e.sessionId}`));
  bus.on("turnStarted", (e) => seen.push(`b:${e.sessionId}`));
  bus.emit("turnStarted", { sessionId: "claude:1" });
  off();
  bus.emit("turnStarted", { sessionId: "claude:2" });
  bus.emit("turnEnded", { sessionId: "claude:2" });
  expect(seen).toEqual(["a:claude:1", "b:claude:1", "b:claude:2"]);
});

test("a throwing listener is reported and doesn't stop the others", () => {
  const errors: string[] = [];
  const bus = new EventBus<CoreEvents>((event) => errors.push(String(event)));
  let reached = false;
  bus.on("error", () => {
    throw new Error("boom");
  });
  bus.on("error", () => (reached = true));
  bus.emit("error", { message: "x" });
  expect(reached).toBe(true);
  expect(errors).toEqual(["error"]);
});

test("once fires a single time", () => {
  const bus = new EventBus<CoreEvents>();
  let n = 0;
  bus.once("modeChanged", () => n++);
  bus.emit("modeChanged", { sessionId: "s", from: "stored", to: "live" });
  bus.emit("modeChanged", { sessionId: "s", from: "live", to: "stored" });
  expect(n).toBe(1);
});
