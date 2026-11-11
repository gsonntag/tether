// Sessions talking to each other (SPEC §9a): which sessions a message to all reaches, and the names
// of Tether's tools for it, shared by the runner's peers module and the web UI.

import type { HarnessId, SessionSummary } from "./transcript";

/** Narrows an agent's tether_broadcast. Empty: every session. */
export interface BroadcastFilter {
  projectPath?: string;
  harness?: HarnessId;
  /** idle, working (a turn runs), or waiting (on you) */
  status?: "idle" | "working" | "waiting";
}

/** A session as people say it's doing. */
export const statusWord = (s: Pick<SessionSummary, "status" | "requests">): "idle" | "working" | "waiting" =>
  s.status === "waiting" || (s.requests ?? 0) > 0 ? "waiting" : s.status === "running" ? "working" : "idle";

/** Whether a session can be messaged at all: listed, not archived, not a subagent. */
export const reachable = (s: SessionSummary) => !s.archived && !s.parentSessionId;

/** The sessions a message to all reaches. */
export function matching(sessions: SessionSummary[], f: BroadcastFilter = {}): SessionSummary[] {
  return sessions.filter((s) => reachable(s) && (!f.projectPath || s.projectPath === f.projectPath) && (!f.harness || s.harness === f.harness) && (!f.status || statusWord(s) === f.status));
}

/** Tether's tools, as the agent sees them (the server is named `tether`). */
export const PEER_SERVER = "tether";
export const PEER_TOOLS = { sessions: "tether_sessions", send: "tether_send", ask: "tether_ask", broadcast: "tether_broadcast" } as const;

/** A peer tool's action from its full name (mcp__tether__tether_ask, or Codex's), else undefined. */
export function peerAction(name: string): keyof typeof PEER_TOOLS | undefined {
  const m = /(?:^|__|\.)tether_(sessions|send|ask|broadcast)$/.exec(name);
  return m ? (m[1] as keyof typeof PEER_TOOLS) : undefined;
}

/**
 * The session a peer tool's answer says it reached: the first `"<title>" (<id>)` on its first line
 * (the runner writes it once the message is in that session's queue), else undefined.
 */
export function peerTarget(output: string | undefined): { id: string; title: string } | undefined {
  const m = /"([^"\n]{0,200})" \(([a-z]+:[^\s()]{1,200})\)/.exec((output ?? "").split("\n", 1)[0]!);
  return m ? { id: m[2]!, title: m[1]! } : undefined;
}
