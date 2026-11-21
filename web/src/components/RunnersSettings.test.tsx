import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { KnownRunner } from "../runners";

(globalThis as any).location ??= { protocol: "http:", host: "localhost" };
(globalThis as any).document ??= { addEventListener() {}, visibilityState: "visible" };
(globalThis as any).window ??= { addEventListener() {} };
(globalThis as any).requestAnimationFrame ??= () => 0;

const { RunnerCard } = await import("./RunnersSettings");

const runner = (extra: Partial<KnownRunner> = {}): KnownRunner => ({
  id: "r1",
  name: "Box One",
  hostname: "box1.local",
  version: "0.2.0",
  protocol: 1,
  harnesses: [],
  online: true,
  lastSeen: 1,
  ...extra,
});

test("shows short commit hash + date, and 'local changes' if dirty", () => {
  const rClean = runner({ build: { commit: "a1b2c3d", date: "2026-11-21", branch: "main", dirty: false } });
  const htmlClean = renderToStaticMarkup(<RunnerCard runner={rClean} />);
  expect(htmlClean).toContain("a1b2c3d · 2026-11-21");
  expect(htmlClean).not.toContain("local changes");

  const rDirty = runner({ build: { commit: "f9e8d7c", date: "2026-11-20", branch: "dev", dirty: true } });
  const htmlDirty = renderToStaticMarkup(<RunnerCard runner={rDirty} />);
  expect(htmlDirty).toContain("f9e8d7c · 2026-11-20 · local changes");
});

test("shows quiet warning if server commit is known and differs from runner commit", () => {
  const r = runner({ build: { commit: "f9e8d7c", date: "2026-11-20", branch: "dev", dirty: false } });
  const serverBuild = { commit: "a1b2c3d", date: "2026-11-21", dirty: false };
  const htmlDiff = renderToStaticMarkup(<RunnerCard runner={r} serverBuild={serverBuild} />);
  expect(htmlDiff).toContain("Different from the app&#x27;s build (a1b2c3d): restart the runner to update");

  // Same commit shows no warning
  const htmlSame = renderToStaticMarkup(<RunnerCard runner={runner({ build: { commit: "a1b2c3d", date: "2026-11-21", dirty: false } })} serverBuild={serverBuild} />);
  expect(htmlSame).not.toContain("Different from the app");
});

test("falls back to runner.version when build stamp is absent", () => {
  const legacy = runner({ version: "0.2.0", build: undefined });
  const html = renderToStaticMarkup(<RunnerCard runner={legacy} />);
  expect(html).toContain("0.2.0");
  expect(html).not.toContain("Different from the app's build");
});
