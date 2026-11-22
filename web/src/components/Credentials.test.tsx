import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { KnownRunner } from "../runners";

(globalThis as any).location ??= { protocol: "http:", host: "localhost", hash: "#/settings/credentials", replace() {} };
(globalThis as any).document ??= { addEventListener() {}, visibilityState: "visible" };
(globalThis as any).window ??= { addEventListener() {} };
(globalThis as any).requestAnimationFrame ??= () => 0;

const { Settings } = await import("./Credentials");

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

test("shared person with only drive or view runners sees only Notifications in menu", () => {
  const drivenRunner = runner("box-driven", { access: "drive" });
  const html = renderToStaticMarkup(
    <Settings page="credentials" runners={[drivenRunner]} role="editor" />,
  );

  // Nav menu must only contain Notifications, nothing else
  expect(html).toContain('href="#/settings/notifications"');
  expect(html).not.toContain('href="#/settings/credentials"');
  expect(html).not.toContain('href="#/settings/runners"');
  expect(html).not.toContain('href="#/settings/azure"');
  expect(html).not.toContain('href="#/settings/texting"');
  expect(html).not.toContain('href="#/settings/agents"');
  expect(html).not.toContain('href="#/settings/updates"');
  expect(html).not.toContain('href="#/settings/usage"');

  // Renders Notifications directly instead of "No runner connected" or "offline" error
  expect(html).toContain("Notifications");
  expect(html).not.toContain("No runner connected.");
  expect(html).not.toContain("Runner offline.");
});

test("owner with managed runner sees full settings menu", () => {
  const managedRunner = runner("main-dev");
  const html = renderToStaticMarkup(
    <Settings page="credentials" runners={[managedRunner]} role="owner" />,
  );

  expect(html).toContain('href="#/settings/runners"');
  expect(html).toContain('href="#/settings/credentials"');
  expect(html).toContain('href="#/settings/azure"');
  expect(html).toContain('href="#/settings/texting"');
  expect(html).toContain('href="#/settings/notifications"');
  expect(html).toContain('href="#/settings/agents"');
  expect(html).toContain('href="#/settings/updates"');
  expect(html).toContain('href="#/settings/usage"');
});

test("runner pickers list only runners that allow the page's ops", () => {
  const managedRunner1 = runner("r-manage1", { name: "Managed 1" });
  const managedRunner2 = runner("r-manage2", { name: "Managed 2" });
  const drivenRunner = runner("r-drive", { name: "Driven", access: "drive" });

  const html = renderToStaticMarkup(
    <Settings page="credentials" runners={[managedRunner1, managedRunner2, drivenRunner]} role="owner" />,
  );

  // Both managed runners appear in the picker
  expect(html).toContain("Managed 1");
  expect(html).toContain("Managed 2");
  // The driven runner must NOT appear in the Credentials runner picker
  expect(html).not.toContain("Driven");
});
