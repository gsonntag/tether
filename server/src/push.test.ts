import { expect, test } from "bun:test";
import { generateVapidKeys, loadPushKeys, validVapid } from "./push";

test("a generated pair is in web-push's format", async () => {
  const k = await generateVapidKeys();
  expect(validVapid(k.publicKey, k.privateKey)).toBe(true);
  expect(Buffer.from(k.publicKey, "base64url").length).toBe(65);
});

test("keys come from env; production without them has push off; dev makes a pair", async () => {
  const k = await generateVapidKeys();
  const env = await loadPushKeys({ TETHER_VAPID_PUBLIC_KEY: k.publicKey, TETHER_VAPID_PRIVATE_KEY: k.privateKey, TETHER_PUSH_SUBJECT: "mailto:a@b" }, false);
  expect(env.keys).toEqual({ ...k, subject: "mailto:a@b" });
  expect((await loadPushKeys({}, false)).keys).toBeUndefined();
  expect((await loadPushKeys({ TETHER_VAPID_PUBLIC_KEY: "x", TETHER_VAPID_PRIVATE_KEY: "y" }, true)).keys).toBeUndefined();
  const dev = await loadPushKeys({}, true);
  expect(validVapid(dev.keys!.publicKey, dev.keys!.privateKey)).toBe(true);
});
