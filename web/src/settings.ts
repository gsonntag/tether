import { accessAllows } from "../../shared/access";
import type { OpName, RunnerInfo } from "../../shared/protocol";
import { accessOf } from "./runners";

export type SettingsPage = "runners" | "credentials" | "accounts" | "azure" | "bedrock" | "texting" | "notifications" | "display" | "agents" | "updates" | "usage";

/** Pages about this person and device, not a runner: everyone sees them. */
const PERSONAL_PAGES = ["notifications", "display"] as const;

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  "runners",
  "credentials",
  "accounts",
  "azure",
  "bedrock",
  "texting",
  "notifications",
  "display",
  "agents",
  "updates",
  "usage",
];

export const PAGE_OPS: Record<Exclude<SettingsPage, (typeof PERSONAL_PAGES)[number]>, OpName> = {
  runners: "setRunnerAccess",
  credentials: "credentials",
  accounts: "credentials",
  azure: "setAzure",
  bedrock: "setBedrock",
  texting: "messagingStatus",
  agents: "setRunnerSettings",
  updates: "harnessUpdate",
  usage: "usage",
};

export const PAGE_LABELS: Record<SettingsPage, string> = {
  runners: "Runners",
  credentials: "Credentials",
  accounts: "Accounts",
  azure: "Azure",
  bedrock: "Bedrock",
  texting: "Messaging",
  notifications: "Notifications",
  display: "Display",
  agents: "Agents",
  updates: "Updates",
  usage: "Usage",
};

/**
 * Runners that may be used for this settings page, derived from shared/access.ts MANAGE_OPS and VIEW_OPS.
 * Notifications and Display are personal/device-level, so all runners are kept.
 */
export function runnersForPage<T extends Pick<RunnerInfo, "access">>(runners: readonly T[], page: SettingsPage): T[] {
  const op = PAGE_OPS[page as keyof typeof PAGE_OPS];
  if (!op) return [...runners];
  return runners.filter((r) => accessAllows(accessOf(r), op));
}

/** Whether this settings page has anything the signed-in person can use. */
export function isPageVisible(runners: readonly Pick<RunnerInfo, "access">[], page: SettingsPage, role?: string): boolean {
  if ((PERSONAL_PAGES as readonly string[]).includes(page)) return true;
  // App owners see Settings → Runners to see their runners or "No runners of yours have connected yet".
  if (page === "runners" && role === "owner") return true;
  return runnersForPage(runners, page).length > 0;
}

/** The settings pages to show in the Settings menu. */
export function visibleSettingsPages(runners: readonly Pick<RunnerInfo, "access">[], role?: string): SettingsPage[] {
  return SETTINGS_PAGES.filter((p) => isPageVisible(runners, p, role));
}

/** The first settings page to land on: credentials if available, else the first visible page. */
export function defaultSettingsPage(runners: readonly Pick<RunnerInfo, "access">[], role?: string): SettingsPage {
  const visible = visibleSettingsPages(runners, role);
  if (visible.includes("credentials")) return "credentials";
  return visible[0] ?? "notifications";
}

/** Resolves an asked page: if visible, use it; otherwise fall back to the default available page. */
export function resolveSettingsPage(asked: SettingsPage, runners: readonly Pick<RunnerInfo, "access">[], role?: string): SettingsPage {
  return isPageVisible(runners, asked, role) ? asked : defaultSettingsPage(runners, role);
}

/** Whether `page` is any Settings subpage. */
export function isSettingsPage(page: string): page is SettingsPage {
  return (SETTINGS_PAGES as readonly string[]).includes(page);
}
