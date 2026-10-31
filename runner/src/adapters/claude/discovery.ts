// Claude Code sessions and projects as Tether lists them, read from ~/.claude/projects without
// starting anything. Sessions sort by their last message (yours or Claude's), not the file's
// mtime, which also moves on titles and settings (lastActivity.ts).

import { getSessionInfo, listSessions, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Msg, ProjectInfo, SessionSummary } from "../../../../shared/transcript";
import { claudePick, lastLineTime } from "../lastActivity";
import { titleText } from "../../../../shared/fromTether";
import { cleanUserText } from "./content";
import { readHistory } from "./history";
import { sessionFile, splitNative, storedSubagents } from "./paths";

/**
 * Claude's own summary, if it has one: the SDK falls back to the last or first prompt, and a local
 * command (/exit) or the first prompt repeated says nothing of its own.
 */
const ownSummary = (s: Pick<SDKSessionInfo, "summary" | "firstPrompt">) => (s.summary && s.summary !== s.firstPrompt && !cleanUserText(s.summary).trimStart().startsWith("/") ? s.summary : undefined);

/** The title the sidebar shows: yours (/rename), Claude's, or the first prompt. */
export function titleOf(s: Pick<SDKSessionInfo, "customTitle" | "summary" | "firstPrompt">): string {
  // A slash command (/clear, /model) says nothing about the session.
  // Tether's own messages are titled by what they are ("$ npm test"), never by their marker.
  const first = titleText(cleanUserText(s.firstPrompt ?? "")).trim();
  const raw = s.customTitle || ownSummary(s) || (first.startsWith("/") ? "" : first) || "Untitled";
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

/**
 * A store with no conversation in it: nothing but local commands (/exit, /clear typed in a TUI nobody
 * used), which Claude stores all the same. Such a session never started (SPEC §8).
 */
export async function claudeNeverStarted(nativeId: string, projectPath: string): Promise<boolean> {
  const msgs = await readHistory(nativeId, projectPath).catch(() => undefined);
  return !!msgs && onlyLocalCommands(msgs);
}

/** A prompt may start with "/" too (/tmp/notes.txt): only an entry stored as a command is one. */
export const onlyLocalCommands = (msgs: Msg[]) => msgs.every((m) => m.role === "notice" || (m.role === "user" && m.localCommand));

/** Claude's `permission-mode` entries in a session's store: how many, and the last one's mode. */
export async function claudeStoredMode(nativeId: string, projectPath: string): Promise<{ mode?: string; entries: number }> {
  const file = sessionFile(splitNative(nativeId).session, projectPath);
  const text = file ? await readFile(file, "utf8").catch(() => "") : "";
  return storedModeIn(text);
}

export function storedModeIn(text: string) {
  let mode: string | undefined;
  let entries = 0;
  for (const line of text.split("\n")) {
    if (!line.includes('"permission-mode"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.type !== "permission-mode" || typeof e.permissionMode !== "string") continue;
      mode = e.permissionMode;
      entries++;
    } catch {}
  }
  return { mode, entries };
}

/** Every session (in one folder when `projectPath` is given) with activity since `since`. */
export async function claudeSessions(opts: { projectPath?: string; since?: number } = {}): Promise<SessionSummary[]> {
  const list = opts.projectPath ? await listSessions({ dir: opts.projectPath, includeWorktrees: false }) : await listSessions();
  // The file's mtime is never older than its last message: a cheap first cut.
  const recent = list.filter((s) => s.cwd && (!opts.since || s.lastModified >= opts.since) && (!opts.projectPath || s.cwd === opts.projectPath));
  // Only a session with no title of its own and a slash command (or nothing) first can be empty.
  const maybeEmpty = (s: SDKSessionInfo) => !s.customTitle && !ownSummary(s) && (!cleanUserText(s.firstPrompt ?? "").trim() || cleanUserText(s.firstPrompt ?? "").trimStart().startsWith("/"));
  const started = await Promise.all(recent.map(async (s) => (maybeEmpty(s) && (await claudeNeverStarted(s.sessionId, s.cwd!)) ? undefined : s)));
  const out = await Promise.all(started.filter((s) => s !== undefined).map((s) => summaryOf(s, s.cwd!)));
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
