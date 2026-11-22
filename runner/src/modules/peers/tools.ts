// The tools every agent gets for talking to other sessions, and to the person by text (SPEC §9a), as MCP describes them. The
// stdio server (mcp.ts) lists these; the runner (index.ts) runs them.

import { PEER_TOOLS, TEXT_PERSON } from "../../../../shared/peers";

/** Longest an ask waits for its answer, and its default (minutes). */
export const ASK_MAX_MIN = 60;
export const ASK_DEFAULT_MIN = 15;

const to = { type: "string", description: 'The session: its id (like "claude:…", "codex:…" or "antigravity:…", from tether_sessions) or its exact title.' };
const text = { type: "string", description: "The message. It reaches the other agent as written, marked as coming from you." };

export const TOOL_DEFS = [
  {
    name: PEER_TOOLS.sessions,
    description:
      "Lists the other coding sessions on this machine that you can message: id, title, project folder, agent (Claude Code, Codex or Antigravity), whether it's idle, working or waiting on the person, and when it was last active.",
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
    name: PEER_TOOLS.start,
    description:
      "Use the subscription by default when available. You must confirm API-key billing with the user before starting any session, including a replacement or fallback session. Confirm any automatic fallback providers and their order too. Tether configures each source itself from its Settings (keys, Azure resource and deployments): never edit the agent's own config or set API-key environment variables for it. tether_models lists the sources and models you can pass. Starts a new coding session on any agent (Claude Code, Codex or Antigravity), with your prompt as its first message, and returns at once. It works on its own like one of your subagents, in this session's folder unless you pass `project` (or in a git worktree with `worktree`: a new one, or an existing one). Its permissions are never looser than yours. Each time it finishes a turn, its final reply comes to you as a message from it; if it isn't done, follow up with tether_send to its id, or start a fresh session for new context. It stays in the person's sidebar until you archive it: once you're done with it, archive it with tether_archive. The person can open, steer and stop it in Tether.",
    inputSchema: {
      type: "object",
      properties: {
        harness: { type: "string", enum: ["claude", "codex", "antigravity"], description: "Which agent runs it: claude (Claude Code), codex, or antigravity." },
        prompt: { type: "string", description: "The complete brief: it starts with no other context." },
        source: { type: "string", enum: ["subscription", "anthropic", "openai", "azure", "bedrock"], description: "Defaults to subscription when available. API-key sources require user confirmation. Azure and Bedrock use the models configured in Tether Settings. tether_models lists what's available." },
        model: { type: "string", description: "Its model, when one was asked for (else the agent's default). On Azure or Bedrock, use a configured deployment or model ID. tether_models lists them." },
        effort: { type: "string", description: "Its reasoning effort (low, medium, high, …), when one was asked for." },
        title: { type: "string", description: "A short title for it, as Tether's sidebar shows it." },
        project: { type: "string", description: "Another project folder to run in, instead of this session's." },
        worktree: {
          anyOf: [{ type: "boolean" }, { type: "string" }],
          description:
            "true: it works in a new git worktree of the project (its own folder and branch), so it doesn't touch this checkout. A path or branch instead: it works in that existing worktree of the project (another session's, to carry on its work, or one made by hand); nothing is made and no setup runs. Only in a git repo.",
        },
      },
      required: ["harness", "prompt"],
    },
  },
  {
    name: PEER_TOOLS.models,
    description:
      "Lists, for one agent, the billing sources tether_start can use on this runner (subscription, Anthropic or OpenAI API key, Azure) and the models each offers, with their effort levels. Azure's models are the deployments set in Tether's Settings. Tether sets up each source's provider and key itself.",
    inputSchema: { type: "object", properties: { harness: { type: "string", enum: ["claude", "codex", "antigravity"], description: "Which agent: claude (Claude Code), codex, or antigravity." } }, required: ["harness"] },
  },
  {
    name: PEER_TOOLS.archive,
    description:
      "Archives a session you started with tether_start, once you're done with it, so it leaves the person's sidebar (only sessions they started stay there). It also archives the idle sessions that one started. Only your own started sessions, and not while it's still working (wait for its report, or tether_send it to stop), nor one the person took over or pinned. It stops reporting to you, and the answer says whether its worktree was removed or kept (and why). The person can still find it in Tether's archive.",
    inputSchema: { type: "object", properties: { to: { type: "string", description: "The session you started: its id (from tether_start's answer or its reports) or its title." } }, required: ["to"] },
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
  {
    name: TEXT_PERSON,
    description:
      "Texts the person through Tether, in the messaging app it reaches them on, marked with this session's number. Use it only when they asked to be texted (\"text me when it's done\") or you're blocked on something only they can answer. Keep it to one short sentence (it's cut at 300 characters), outcome first, with a link if there is one. Optionally send one image after it (a screenshot, a chart): its absolute path in `image` (PNG, JPEG, GIF, WebP or HEIC, at most 10 MB; other files are refused). If they reply, their reply comes to this session as a message (files they send come as attachments). Only works when the person ticked \"Session can text me\" on this session; otherwise nothing is sent and it returns an error.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The text: one short sentence." },
        image: { type: "string", description: "Optional: the absolute path of an image file to send after the text (.png, .jpg, .gif, .webp or .heic, at most 10 MB)." },
      },
      required: ["message"],
    },
  },
];
