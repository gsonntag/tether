import { describe, expect, test } from "bun:test";
import type { RunnerInfo } from "../../shared/protocol";
import { defaultSettingsPage, isPageVisible, isSettingsPage, resolveSettingsPage, runnersForPage, visibleSettingsPages } from "./settings";

const runner = (id: string, access?: "drive" | "view"): Pick<RunnerInfo, "id" | "access"> => ({
  id,
  ...(access ? { access } : {}),
});

describe("settings access filtering", () => {
  const managed = runner("box-managed");
  const driven = runner("box-driven", "drive");
  const viewed = runner("box-viewed", "view");

  test("runnersForPage filters runners by the page's required op", () => {
    const list = [managed, driven, viewed];
    expect(runnersForPage(list, "credentials").map((r) => r.id)).toEqual(["box-managed"]);
    expect(runnersForPage(list, "azure").map((r) => r.id)).toEqual(["box-managed"]);
    expect(runnersForPage(list, "texting").map((r) => r.id)).toEqual(["box-managed"]);
    expect(runnersForPage(list, "agents").map((r) => r.id)).toEqual(["box-managed"]);
    expect(runnersForPage(list, "updates").map((r) => r.id)).toEqual(["box-managed"]);
    expect(runnersForPage(list, "usage").map((r) => r.id)).toEqual(["box-managed"]);
    expect(runnersForPage(list, "runners").map((r) => r.id)).toEqual(["box-managed"]);

    // Notifications is device-level: keeps all runners
    expect(runnersForPage(list, "notifications").map((r) => r.id)).toEqual(["box-managed", "box-driven", "box-viewed"]);
  });

  test("isPageVisible: hide pages with nothing left", () => {
    // Only shared runners: all 7 manage pages are hidden
    const sharedOnly = [driven, viewed];
    expect(isPageVisible(sharedOnly, "credentials")).toBe(false);
    expect(isPageVisible(sharedOnly, "azure")).toBe(false);
    expect(isPageVisible(sharedOnly, "texting")).toBe(false);
    expect(isPageVisible(sharedOnly, "agents")).toBe(false);
    expect(isPageVisible(sharedOnly, "updates")).toBe(false);
    expect(isPageVisible(sharedOnly, "usage")).toBe(false);
    expect(isPageVisible(sharedOnly, "runners")).toBe(false);
    expect(isPageVisible(sharedOnly, "notifications")).toBe(true);

    // App owner with no runners sees Runners and Notifications
    expect(isPageVisible([], "runners", "owner")).toBe(true);
    expect(isPageVisible([], "credentials", "owner")).toBe(false);
    expect(isPageVisible([], "notifications", "owner")).toBe(true);

    // Shared person with no runners sees only Notifications
    expect(isPageVisible([], "runners", "editor")).toBe(false);
    expect(isPageVisible([], "notifications", "editor")).toBe(true);
  });

  test("visibleSettingsPages: shared person sees only Notifications", () => {
    const sharedOnly = [driven];
    expect(visibleSettingsPages(sharedOnly, "editor")).toEqual(["notifications"]);

    // Owner with managed runner sees all pages
    const ownerList = [managed];
    expect(visibleSettingsPages(ownerList, "owner")).toEqual([
      "runners",
      "credentials",
      "azure",
      "texting",
      "notifications",
      "agents",
      "updates",
      "usage",
    ]);
  });

  test("defaultSettingsPage and resolveSettingsPage fall back cleanly", () => {
    const sharedOnly = [driven];
    expect(defaultSettingsPage(sharedOnly, "editor")).toBe("notifications");
    expect(resolveSettingsPage("credentials", sharedOnly, "editor")).toBe("notifications");
    expect(resolveSettingsPage("azure", sharedOnly, "editor")).toBe("notifications");
    expect(resolveSettingsPage("notifications", sharedOnly, "editor")).toBe("notifications");

    const ownerList = [managed];
    expect(defaultSettingsPage(ownerList, "owner")).toBe("credentials");
    expect(resolveSettingsPage("azure", ownerList, "owner")).toBe("azure");
  });

  test("isSettingsPage recognizes all settings subpages", () => {
    expect(isSettingsPage("runners")).toBe(true);
    expect(isSettingsPage("credentials")).toBe(true);
    expect(isSettingsPage("azure")).toBe(true);
    expect(isSettingsPage("texting")).toBe(true);
    expect(isSettingsPage("notifications")).toBe(true);
    expect(isSettingsPage("agents")).toBe(true);
    expect(isSettingsPage("updates")).toBe(true);
    expect(isSettingsPage("usage")).toBe(true);

    expect(isSettingsPage("home")).toBe(false);
    expect(isSettingsPage("session")).toBe(false);
  });
});
