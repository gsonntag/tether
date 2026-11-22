import { describe, expect, test } from "bun:test";
import { accessAllows, cleanEmail, cleanGrants, grantedAccess, MANAGE_OPS, VIEW_OPS } from "./access";
import type { OpName } from "./protocol";

describe("access control", () => {
  test("manage access allows all ops, including manage and view ops", () => {
    for (const op of MANAGE_OPS) {
      expect(accessAllows("manage", op)).toBe(true);
    }
    for (const op of VIEW_OPS) {
      expect(accessAllows("manage", op)).toBe(true);
    }
    expect(accessAllows("manage", "send")).toBe(true);
    expect(accessAllows("manage", "openTerminal")).toBe(true);
  });

  test("drive access allows driving and view ops, but not manage ops", () => {
    expect(accessAllows("drive", "send")).toBe(true);
    expect(accessAllows("drive", "openTerminal")).toBe(true);
    expect(accessAllows("drive", "listSessions")).toBe(true);
    expect(accessAllows("drive", "history")).toBe(true);

    for (const op of MANAGE_OPS) {
      expect(accessAllows("drive", op)).toBe(false);
    }

    // Explicitly verify runnerSettings, harnessVersions, and usage are blocked for drive
    expect(accessAllows("drive", "runnerSettings")).toBe(false);
    expect(accessAllows("drive", "harnessVersions")).toBe(false);
    expect(accessAllows("drive", "usage")).toBe(false);
  });

  test("view access allows only view ops", () => {
    for (const op of VIEW_OPS) {
      expect(accessAllows("view", op)).toBe(true);
    }

    expect(accessAllows("view", "send")).toBe(false);
    expect(accessAllows("view", "openTerminal")).toBe(false);
    expect(accessAllows("view", "gitDiff")).toBe(false);
    expect(accessAllows("view", "readFile")).toBe(false);

    for (const op of MANAGE_OPS) {
      expect(accessAllows("view", op)).toBe(false);
    }

    expect(accessAllows("view", "usage")).toBe(false);
    expect(accessAllows("view", "runnerSettings")).toBe(false);
    expect(accessAllows("view", "harnessVersions")).toBe(false);
  });

  test("cleanEmail cleans and normalizes emails", () => {
    expect(cleanEmail("  Alice@Example.COM  ")).toBe("alice@example.com");
    expect(cleanEmail("invalid")).toBe("");
    expect(cleanEmail("anon:123")).toBe("");
    expect(cleanEmail("svc:123")).toBe("");
    expect(cleanEmail(null)).toBe("");
  });

  test("cleanGrants deduplicates and validates grants", () => {
    const raw = [
      { email: "a@x.com", access: "drive" },
      { email: "A@X.COM", access: "view" },
      { email: "b@x.com", access: "view" },
      { email: "invalid", access: "drive" },
    ];
    const grants = cleanGrants(raw);
    expect(grants).toEqual([
      { email: "a@x.com", access: "drive" },
      { email: "b@x.com", access: "view" },
    ]);
  });

  test("grantedAccess checks email and caps by Foliation role", () => {
    const grants = [
      { email: "ed@x.com", access: "drive" as const },
      { email: "vi@x.com", access: "view" as const },
    ];
    expect(grantedAccess(grants, "ED@x.com", "editor")).toBe("drive");
    // Viewer role on app caps drive grant down to view
    expect(grantedAccess(grants, "ED@x.com", "viewer")).toBe("view");
    expect(grantedAccess(grants, "vi@x.com", "editor")).toBe("view");
    expect(grantedAccess(grants, "unknown@x.com", "editor")).toBeNull();
    // Role outside owner/editor/viewer gets null
    expect(grantedAccess(grants, "ed@x.com", "none")).toBeNull();
  });
});
