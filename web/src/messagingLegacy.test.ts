import { expect, test } from "bun:test";
import { isUnknownOp, legacyMessaging, legacySet } from "./messagingLegacy";

test("an old runner's texting shows as one iMessage section, and saves through setTexting", () => {
  const m = legacyMessaging({ enabled: true, phoneLast4: "1234", keysSet: true, fromEnv: { phone: false, keys: true }, connected: false, lastError: "Couldn't connect to Photon: x" });
  expect(m.connectors.length).toBe(1);
  const c = m.connectors[0]!;
  expect([c.id, c.enabled, c.configured, c.connected, c.lastError]).toEqual(["imessage", true, true, false, "Couldn't connect to Photon: x"]);
  expect(c.forms.map((f) => [f.key, f.status, !!f.fromEnv, !!f.unset])).toEqual([["phone", "••••1234", false, false], ["project", "Set · from runner.env", true, false]]);
  expect(legacyMessaging({ enabled: false, keysSet: false, fromEnv: { phone: false, keys: false }, connected: false }).connectors[0]!.configured).toBe(false);
  expect(legacySet({ enabled: false })).toEqual({ enabled: false });
  expect(legacySet({ values: { projectId: "p", projectSecret: "s", other: "x" } })).toEqual({ projectId: "p", projectSecret: "s" });
  expect(legacySet({ values: { phone: "" } })).toEqual({ phone: "" });
});

test("only a runner that doesn't know the op falls back", () => {
  expect(isUnknownOp(new Error('This runner doesn\'t know "messagingStatus". Update and restart it.'), "messagingStatus")).toBe(true);
  expect(isUnknownOp(new Error("Runner offline."), "messagingStatus")).toBe(false);
  expect(isUnknownOp(new Error("timed out"), "messagingStatus")).toBe(false);
  expect(isUnknownOp(new Error('This runner doesn\'t know "textingStatus". Update and restart it.'), "messagingStatus")).toBe(false);
  expect(isUnknownOp(undefined, "messagingStatus")).toBe(false);
});
