// Claude Code sessions and projects as Tether lists them, read from ~/.claude/projects without
// starting anything. Sessions sort by their last message (yours or Claude's), not the file's
// mtime, which also moves on titles and settings (lastActivity.ts).

import { getSessionInfo, listSessions, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { ProjectInfo, SessionSummary } from "../../../../shared/transcript";
import { claudePick, lastLineTime } from "../lastActivity";
import { cleanUserText } from "./content";
import { sessionFile, splitNative, storedSubagents } from "./paths";

/** The title the sidebar shows: yours (/rename), Claude's, or the first prompt. */
export function titleOf(s: Pick<SDKSessionInfo, "customTitle" | "summary" | "firstPrompt">): string {
  // A slash command (/clear, /model) says nothing about the session.
  const first = cleanUserText(s.firstPrompt ?? "").trim();
  const raw = s.customTitle || s.summary || (first.startsWith("/") ? "" : first) || "Untitled";
  return raw.replace(/\s+/g, " ").trim().slice(0, 160) || "Untitled";
}

async function summaryOf(s: SDKSessionInfo, projectPath: string): Promise<SessionSummary> {
  const file = sessionFile(s.sessionId, projectPath);
  const at = file ? await lastLineTime(file, claudePick, s.fileSize !== undefined ? { mtime: s.lastModified, size: s.fileSize } : undefined) : undefined;
  return {
    id: `claude:${s.sessionId}`,
    harness: "claude",
    nativeId: s.sessionId,
    projectPath,
    title: titleOf(s),
    mode: "stored",
    status: "idle",
    updatedAt: at ?? s.lastModified,
  };
}

/** Every session (in one folder when `projectPath` is given) with activity since `since`. */
export async function claudeSessions(opts: { projectPath?: string; since?: number } = {}): Promise<SessionSummary[]> {
  const list = opts.projectPath ? await listSessions({ dir: opts.projectPath, includeWorktrees: false }) : await listSessions();
  // The file's mtime is never older than its last message: a cheap first cut.
  const recent = list.filter((s) => s.cwd && (!opts.since || s.lastModified >= opts.since) && (!opts.projectPath || s.cwd === opts.projectPath));
  const out = await Promise.all(recent.map((s) => summaryOf(s, s.cwd!)));
  return out.filter((s) => !opts.since || s.updatedAt >= opts.since);
}

/** Folders with sessions, that still exist. */
export async function claudeProjects(): Promise<ProjectInfo[]> {
  const by = new Map<string, ProjectInfo>();
  for (const s of await listSessions()) {
    if (!s.cwd) continue;
    const p = by.get(s.cwd) ?? { path: s.cwd, name: basename(s.cwd) || s.cwd, harnesses: ["claude"], updatedAt: 0, sessions: 0 };
    p.sessions++;
    p.updatedAt = Math.max(p.updatedAt, s.lastModified);
    by.set(s.cwd, p);
  }
  return [...by.values()].filter((p) => existsSync(p.path));
}

/** A subagent's row, from its meta file. */
function childSummary(session: string, projectPath: string, c: ReturnType<typeof storedSubagents>[number]): SessionSummary {
  let updatedAt = 0;
  try {
    updatedAt = statSync(c.file).mtimeMs;
  } catch {}
  return {
    id: `claude:${session}/${c.agentId}`,
    harness: "claude",
    nativeId: `${session}/${c.agentId}`,
    projectPath,
    title: c.meta.description || "Subagent",
    mode: "stored",
    status: "idle",
    updatedAt,
    parentSessionId: `claude:${session}`,
    ...(c.meta.toolUseId ? { parentToolId: c.meta.toolUseId } : {}),
    ...(c.meta.agentType ? { agentType: c.meta.agentType } : {}),
  };
}

/** One session's row (a subagent's too: `<session>/<agent>`). */
export async function claudeSessionInfo(nativeId: string, projectPath?: string): Promise<SessionSummary | undefined> {
  const { session, agent } = splitNative(nativeId);
  const info = await getSessionInfo(session, projectPath ? { dir: projectPath } : undefined).catch(() => undefined);
  const cwd = info?.cwd ?? projectPath;
  if (!agent) return info && cwd ? summaryOf(info, cwd) : undefined;
  if (!cwd) return undefined;
  const c = storedSubagents(session, cwd).find((x) => x.agentId === agent);
  return c && childSummary(session, cwd, c);
}

export function claudeSubagents(session: string, projectPath: string): SessionSummary[] {
  return storedSubagents(session, projectPath).map((c) => childSummary(session, projectPath, c));
}
