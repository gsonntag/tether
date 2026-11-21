// Sharing a runner with people the app is shared with on Foliation (SPEC §3, "Who may connect").
//
// - The app's owners (with TETHER_RUNNER_OWNERS: the people listed for the runner's token) see
//   every runner and manage it, including who else may use it.
// - Anyone else with a share on the app (Foliation role editor or viewer) sees only the runners
//   whose owner added their email, each with "drive" or "view" (VIEW_OPS: read only). Their
//   Foliation role caps it: a viewer share only ever views.
// - The list lives on the runner (runner.json `sharedWith`), so it survives server redeploys, and
//   the relay enforces it on every frame.

import type { OpName } from "./protocol";

/** What one person may do on one runner. */
export type RunnerAccess = "manage" | "drive" | "view";

/** The ops someone with view access may use: reading sessions, never changing anything. */
export const VIEW_OPS: ReadonlySet<OpName> = new Set<OpName>([
  "ping",
  "subscribe",
  "unsubscribe",
  "history",
  "fullPart",
  "listProjects",
  "listSessions",
  "homeAgent",
  // A short link's session (making one, linkFor, stores a code: not a view op).
  "resolveLink",
  // Never the git or files modules' ops: they read the session's folder itself, secrets too
  // (runner/src/modules/git and files say so). Nor the worktrees module's: workspaceInfo and
  // listWorktrees read the repo (its setup, branches, folders); starting a session (newSession,
  // newWorktreeSession, existingWorktreeSession) is driving.
]);

/**
 * The ops only the runner's owners may use: who it's shared with, and the owner's own
 * runner-wide setup (keys, texting to their phone, updates, name, settings).
 */
export const MANAGE_OPS: ReadonlySet<OpName> = new Set<OpName>([
  "setRunnerAccess",
  "setRunnerName",
  "setRunnerSettings",
  "credentials",
  "setCredential",
  "unsetCredential",
  "setAzure",
  "testAzure",
  "textingStatus",
  "setTexting",
  "textingTest",
  "messagingStatus",
  "setConnector",
  "setMessagingPrefer",
  "testConnector",
  "setTextingHub",
  // Which sessions may text the owner's phone.
  "setCanText",
  "harnessAutoUpdate",
  "harnessUpdate",
  // The Home agent is the owner's own: what it runs on, texting its replies to their phone, its
  // check-ins and what it watches. People it's shared with may chat with it, not reconfigure it.
  "homeAgentSet",
  "homeAgentReplyByText",
  "homeAgentCheckIn",
  "homeAgentWatch",
]);

/** Whether this access level may use this op. */
export function accessAllows(access: RunnerAccess, op: OpName): boolean {
  if (access === "manage") return true;
  if (access === "drive") return !MANAGE_OPS.has(op);
  return VIEW_OPS.has(op);
}

/** One person a runner is shared with, and what the owner lets them do. */
export interface RunnerGrant {
  email: string;
  access: "drive" | "view";
}

/** At most this many people per runner. */
export const SHARED_MAX = 100;

/**
 * An email as typed, ready to compare: trimmed and ASCII-lowercased; "" unless it looks like an
 * email and is plain ASCII (Unicode folding would let lookalikes match, as in server/src/tenancy.ts).
 */
export function cleanEmail(v: unknown): string {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (s.length > 254 || !/^[\x21-\x7e]+@[\x21-\x7e]+$/.test(s) || s.startsWith("anon:") || s.startsWith("svc:")) return "";
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** A share list: clean, one entry per email (the first wins), at most SHARED_MAX. Anything unusable is left out. */
export function cleanGrants(v: unknown): RunnerGrant[] {
  if (!Array.isArray(v)) return [];
  const out: RunnerGrant[] = [];
  for (const g of v) {
    if (!g || typeof g !== "object") continue;
    const email = cleanEmail((g as { email?: unknown }).email);
    const access = (g as { access?: unknown }).access === "drive" ? "drive" : "view";
    if (email && !out.some((o) => o.email === email)) out.push({ email, access });
    if (out.length >= SHARED_MAX) break;
  }
  return out;
}

/**
 * What a signed-in person may do on a runner they don't own: its grant for their email, capped by
 * their Foliation role on the app (a viewer share never drives). Null: they can't see it.
 */
export function grantedAccess(grants: readonly RunnerGrant[] | undefined, email: string, role: string): "drive" | "view" | null {
  const e = cleanEmail(email);
  if (!e || (role !== "editor" && role !== "viewer" && role !== "owner")) return null;
  const g = grants?.find((x) => x.email === e);
  if (!g) return null;
  return g.access === "drive" && role !== "viewer" ? "drive" : "view";
}
