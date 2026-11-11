// The tools every agent gets for talking to other sessions (SPEC §9a), as MCP describes them. The
// stdio server (mcp.ts) lists these; the runner (index.ts) runs them.

import { PEER_TOOLS } from "../../../../shared/peers";

/** Longest an ask waits for its answer, and its default (minutes). */
export const ASK_MAX_MIN = 60;
export const ASK_DEFAULT_MIN = 15;

const to = { type: "string", description: 'The session: its id (like "claude:…" or "codex:…", from tether_sessions) or its exact title.' };
const text = { type: "string", description: "The message. It reaches the other agent as written, marked as coming from you." };

export const TOOL_DEFS = [
  {
    name: PEER_TOOLS.sessions,
    description:
      "Lists the other coding sessions on this machine that you can message: id, title, project folder, agent (Claude Code or Codex), whether it's idle, working or waiting on the person, and when it was last active.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Only sessions in this project (its folder path or folder name)." },
        query: { type: "string", description: "Only sessions whose title contains this text." },
      },
    },
  },
  {
    name: PEER_TOOLS.send,
    description:
      "Sends a message to another session and returns at once. It goes into that session's queue: if it is working, it gets the message when its current turn ends. Use it to hand over information or to reply to a session that messaged you. Don't use it to start a back-and-forth chat.",
    inputSchema: { type: "object", properties: { to, text }, required: ["to", "text"] },
  },
  {
    name: PEER_TOOLS.ask,
    description: `Asks another session a question and waits for its answer: its final reply in the turn your question starts. If it is working, your question waits in its queue until its current turn ends. Waits ${ASK_DEFAULT_MIN} minutes by default, at most ${ASK_MAX_MIN}.`,
    inputSchema: {
      type: "object",
      properties: { to, text, timeout_minutes: { type: "number", description: `How long to wait for the answer, in minutes (default ${ASK_DEFAULT_MIN}, at most ${ASK_MAX_MIN}).` } },
      required: ["to", "text"],
    },
  },
  {
    name: PEER_TOOLS.broadcast,
    description:
      "Sends one note to the other sessions in this session's project (at most 20), or with a status. Other projects only when you pass `project`, or `scope: \"all\"` for every project. Fire-and-forget: nobody's answer comes back. Use it rarely, for something every session needs to know (for example: main changed, rebase before pushing).",
    inputSchema: {
      type: "object",
      properties: {
        text,
        project: { type: "string", description: "Sessions in this project (its folder path or folder name) instead of your own." },
        scope: { type: "string", enum: ["project", "all"], description: 'Leave out (or "project") for your own project; "all" for every project.' },
        status: { type: "string", enum: ["idle", "working", "waiting"], description: "Only sessions that are idle, working, or waiting on the person." },
      },
      required: ["text"],
    },
  },
];
