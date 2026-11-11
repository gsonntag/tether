import { expect, test } from "bun:test";
import { compareVersions, parseVersion, statusLabel, updateStatus } from "./harnessUpdates";

test("versions as the CLIs print them", () => {
  expect(parseVersion("2.1.322 (Claude Code)\n")).toBe("2.1.322");
  expect(parseVersion("codex-cli 0.164.0\n")).toBe("0.164.0");
  expect(parseVersion("codex-cli 0.170.0-alpha.1")).toBe("0.170.0-alpha.1");
  expect(parseVersion("tool v1.2")).toBe("1.2");
  expect(parseVersion("no version")).toBeNull();
});

test("semver order, prereleases before their release", () => {
  expect(compareVersions("2.1.322", "2.1.322")).toBe(0);
  expect(compareVersions("0.164.0", "0.167.1")!).toBeLessThan(0);
  expect(compareVersions("2.1.9", "2.1.10")!).toBeLessThan(0); // numeric, not string order
  expect(compareVersions("1.10.0", "1.9.9")!).toBeGreaterThan(0);
  expect(compareVersions("0.170.0-alpha.1", "0.170.0")!).toBeLessThan(0);
  expect(compareVersions("0.170.0-alpha.2", "0.170.0-alpha.10")!).toBeLessThan(0);
  expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")!).toBeLessThan(0);
  expect(compareVersions("1.0.0-alpha.1", "1.0.0-beta")!).toBeLessThan(0);
  expect(compareVersions("v1.2", "1.2.0")).toBe(0);
  expect(compareVersions("1.0.0+build.5", "1.0.0")).toBe(0);
  expect(compareVersions("latest", "1.0.0")).toBeNull();
});

test("status from installed and latest", () => {
  expect(updateStatus("0.164.0", "0.167.1")).toBe("available");
  expect(updateStatus("2.1.322", "2.1.322")).toBe("current");
  expect(updateStatus("0.170.0-alpha.1", "0.167.1")).toBe("current"); // ahead of the release
  expect(updateStatus("1.0.0", undefined)).toBe("unknown");
  expect(updateStatus("1.0.0", "garbage")).toBe("unknown");
  expect(updateStatus(undefined, "1.0.0")).toBe("missing");
  expect(statusLabel({ status: "available", method: "bundled" })).toBe("Needs a Tether release");
  expect(statusLabel({ status: "available", method: "npm" })).toBe("Update available");
  expect(statusLabel({ status: "unknown", method: "npm" })).toBe("Couldn't check");
});
