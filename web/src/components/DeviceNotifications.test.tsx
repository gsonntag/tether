import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { KnownRunner } from "../runners";

(globalThis as any).location ??= { protocol: "http:", host: "localhost" };
(globalThis as any).document ??= { addEventListener() {}, visibilityState: "visible" };
(globalThis as any).window ??= { addEventListener() {}, PushManager: {}, Notification: { permission: "default" } };
(globalThis as any).navigator ??= { serviceWorker: { register: () => Promise.resolve(), ready: Promise.resolve() } };

const { DeviceNotifications } = await import("./DeviceNotifications");

const runner = (id: string, extra: Partial<KnownRunner> = {}): KnownRunner => ({
  id,
  name: id,
  hostname: `${id}.local`,
  version: "0.2.0",
  protocol: 1,
  harnesses: [],
  online: true,
  lastSeen: 1,
  ...extra,
});

test("shows 'Get texts too' link only when a runner allows texting", () => {
  // 1. With a managed runner that allows texting:
  const htmlWithManage = renderToStaticMarkup(
    <DeviceNotifications runners={[runner("box-managed")]} pushKey="test-push-key" state="off" />,
  );
  expect(htmlWithManage).toContain("Get texts too");
  expect(htmlWithManage).toContain('href="#/settings/texting"');

  // 2. With only a shared runner with drive access:
  const htmlWithDrive = renderToStaticMarkup(
    <DeviceNotifications runners={[runner("box-driven", { access: "drive" })]} pushKey="test-push-key" state="off" />,
  );
  expect(htmlWithDrive).not.toContain("Get texts too");
  expect(htmlWithDrive).not.toContain('href="#/settings/texting"');
});
