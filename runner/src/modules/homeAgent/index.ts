// The Home agent: a chat on Home that starts work in a project and sees it through. It is a Claude
// session in its own folder (RunnerOptions.homeFolder) with Tether's tools (core/adapter.ts
// AgentSetup): list the projects, look at one, start a session there with a prompt and full
// permissions, read how a session it started is doing, and send it more. Each time a session it
// started ends a turn, its last reply goes to the chat as a message from Tether, so the agent can
// keep it going until the task is done. A session the person steps into (types in it, or stops
// it) is theirs from then on: no more reports, and the agent can't message it.

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { FROM_TETHER } from "../../../../shared/fromTether";
import { AGENT_NAMES, HARNESS_LABELS, type HarnessId, type Msg } from "../../../../shared/transcript";
import type { AgentSetup, AgentTool } from "../../core/adapter";
import type { Module, ModuleContext } from "..";

/** Reports a session may send before the agent stops following it: a loop can't run forever. */
export const MAX_REPORTS = 12;
/** How much of a session's last reply a report carries. */
const REPLY_MAX = 6000;
/** Each harness's mode that runs without asking. */
const AUTONOMOUS: Record<HarnessId, string> = { claude: "bypassPermissions", codex: "full-access" };

interface Child {
  /** the chat that started it */
  chat: string;
  reports: number;
  /** the person stepped in, or it hit MAX_REPORTS: no more reports, no more messages from the agent */
  released?: "person" | "limit";
}

interface State {
  current?: string;
  children: Record<string, Child>;
}

export const INSTRUCTIONS = `You are Tether's Home agent. The person talks to you from Tether's home page. Your job is to turn what they ask for into a coding session in one of their projects, give it a strong first prompt, and see it through until the task is done.

How to work:
- Find the project with list_projects. Use project_overview when you need to know more about one. If more than one project could be meant, ask the person which in one short question. Never guess.
- Start the work with start_session. The prompt is everything the session knows, so write a complete brief: the goal, the context the person gave you (quote their words where it matters), constraints, and what done means (for example: tests pass, it builds, the change is committed on a branch, etc. only if they asked for it). Tell it to work autonomously to completion without stopping to ask for confirmation, and to verify its work before finishing. The session runs with full permissions.
- Use Claude Code unless the person asks for Codex. Leave the model at its default unless they name one.
- After starting a session, tell the person in one or two sentences what you started and where. Don't poll: Tether sends you a report (a message starting with "[From Tether]") each time a session you started finishes a turn or needs the person.
- On a report: if the task is complete and verified, tell the person briefly what was done. If the session stopped early (it asked something you can answer from what the person said, stopped halfway, or says it's done but skipped verification), use send_to_session with a specific instruction to keep it going. If it needs a decision only the person can make, or it keeps failing, tell the person plainly and stop.
- Never do the coding yourself. You have no shell and can't edit files.
- Be brief. The person reads you on a phone as often as on a computer.`;

const text = (m: Msg) =>
  m.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n")
    .trim();

/** The newest assistant text in `msgs`. */
export function lastReply(msgs: Msg[]): string | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === "assistant" && text(m)) return text(m);
  }
  return undefined;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (cut: ${s.length - n} more characters)` : s);

/** A small, read-only digest of a folder: its README, what's at the top, and git's view. */
async function overview(folder: string): Promise<string> {
  const out: string[] = [`Folder: ${folder}`];
  let names: string[] = [];
  try {
    names = readdirSync(folder, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") || e.name === ".github")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
  } catch (e) {
    out.push(`Can't list it: ${(e as Error).message}`);
  }
  if (names.length) out.push(`Top level (${names.length}): ${names.slice(0, 80).join("  ")}${names.length > 80 ? "  …" : ""}`);
  const git = async (...args: string[]) => {
    try {
      const p = Bun.spawn(["git", ...args], { cwd: folder, stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
      const t = setTimeout(() => p.kill(), 5000);
      const s = await new Response(p.stdout).text();
      clearTimeout(t);
      return (await p.exited) === 0 ? s.trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch) {
    const status = (await git("status", "--porcelain")) ?? "";
    const changed = status ? status.split("\n").length : 0;
    out.push(`Git: on ${branch}, ${changed ? `${changed} changed file${changed === 1 ? "" : "s"}` : "clean"}`);
    const log = await git("log", "--oneline", "-8");
    if (log) out.push(`Recent commits:\n${log}`);
  }
  const readme = names.find((n) => /^readme(\.(md|txt|rst))?$/i.test(n));
  if (readme) {
    try {
      out.push(`${readme}:\n${cut(readFileSync(join(folder, readme), "utf8"), 4000)}`);
    } catch {}
  }
  for (const f of ["CLAUDE.md", "AGENTS.md"])
    if (names.includes(f)) {
      try {
        out.push(`${f}:\n${cut(readFileSync(join(folder, f), "utf8"), 3000)}`);
      } catch {}
    }
  return out.join("\n\n");
}

export class HomeAgent {
  state: State = { children: {} };
  private file: string;

  constructor(private ctx: ModuleContext, readonly folder: string) {
    this.file = join(ctx.dataDir, "state.json");
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8"));
      if (v && typeof v === "object") this.state = { current: typeof v.current === "string" ? v.current : undefined, children: v.children && typeof v.children === "object" ? v.children : {} };
    } catch {}
  }

  private save() {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (e) {
      this.ctx.log(`couldn't save: ${(e as Error).message}`);
    }
  }

  /** The current chat, if it still exists. */
  async current(): Promise<string | undefined> {
    const id = this.state.current;
    if (!id) return undefined;
    try {
      await this.ctx.sessions.open(id);
      return id;
    } catch {
      // Created but never sent to: nothing is stored, so it can't open after a restart.
      return undefined;
    }
  }

  async newChat(): Promise<string> {
    const source = (await this.ctx.sessions.sources("claude")).default ?? "subscription";
    const id = await this.ctx.sessions.create({ harness: "claude", projectPath: this.folder, source, permissionMode: "default" });
    this.state.current = id;
    this.save();
    return id;
  }

  /** Whether `id` is one of the Home agent's own chats. */
  isChat(id: string) {
    const look = this.ctx.session(id);
    return !!look && resolve(look.summary.projectPath) === resolve(this.folder);
  }

  private ownChild(chat: string, id: unknown): [string, Child] {
    if (typeof id !== "string" || !id) throw new Error("session_id is required.");
    const c = this.state.children[id];
    if (!c || c.chat !== chat) throw new Error("That isn't a session you started in this chat.");
    return [id, c];
  }

  /** The tools a chat (by its Claude native id) gets. */
  tools(nativeId: string): AgentTool[] {
    const chat = `claude:${nativeId}`;
    const s = this.ctx.sessions;
    return [
      {
        name: "list_projects",
        description: "The person's projects on this machine (folders with coding sessions), newest activity first.",
        input: {},
        run: async () => {
          const list = await s.projects();
          if (!list.length) return "No projects yet.";
          const ago = (t: number) => {
            const d = Math.round((Date.now() - t) / 86_400_000);
            return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
          };
          return list
            .slice(0, 100)
            .map((p) => `${p.path}  (${p.name}; ${p.sessions} session${p.sessions === 1 ? "" : "s"}; last active ${ago(p.updatedAt)})`)
            .join("\n");
        },
      },
      {
        name: "project_overview",
        description: "A quick read-only look at a project folder: top-level files, git branch and recent commits, README, CLAUDE.md/AGENTS.md.",
        input: { path: z.string().describe("The project's folder, as list_projects gives it (~ works).") },
        run: async (a: { path: string }) => overview(s.folder(a.path)),
      },
      {
        name: "start_session",
        description:
          "Starts a new coding session in a project with your prompt as its first message. It runs with full permissions (no approval prompts) and works on its own; you get a report each time it finishes a turn.",
        input: {
          project_path: z.string().describe("The project's folder (from list_projects)."),
          prompt: z.string().min(1).describe("The complete brief for the session."),
          title: z.string().max(80).optional().describe("A short title for the session, as the sidebar shows it."),
          harness: z.enum(["claude", "codex"]).optional().describe("claude (Claude Code, the default) or codex."),
          model: z.string().optional().describe("Only when the person names a model."),
        },
        run: async (a: { project_path: string; prompt: string; title?: string; harness?: HarnessId; model?: string }) => {
          const harness: HarnessId = a.harness === "codex" ? "codex" : "claude";
          if (!s.adapters().some((x) => x.id === harness)) throw new Error(`${HARNESS_LABELS[harness]} isn't available on this runner.`);
          const folder = s.folder(a.project_path);
          if (resolve(folder) === resolve(this.folder)) throw new Error("That's your own folder, not a project.");
          const source = (await s.sources(harness)).default ?? "subscription";
          const mode = AUTONOMOUS[harness];
          const id = await s.create({ harness, projectPath: folder, source, permissionMode: mode, ...(a.model ? { model: a.model } : {}) });
          this.state.children[id] = { chat, reports: 0 };
          this.save();
          const title = a.title?.replace(/[\x00-\x1f\x7f]/g, " ").trim();
          if (title) await s.rename(id, title).catch(() => {});
          await s.send(id, FROM_TETHER + a.prompt);
          // A way there from the chat.
          const name = folder.replace(/\/+$/, "").split("/").pop() || folder;
          await s.notice(chat, { id: `n-started-${id}`, role: "notice", level: "info", ts: Date.now(), parts: [{ type: "text", text: `Started ${title ? `“${title}”` : "a session"} in ${name}.` }], link: { sessionId: id, label: "Open it" } }).catch(() => {});
          return `Started session ${id} in ${folder} (${HARNESS_LABELS[harness]}, ${mode}). It's working now. You'll get a report when it finishes a turn.`;
        },
      },
      {
        name: "session_status",
        description: "How a session you started is doing: running or idle, what it waits on, and its latest reply.",
        input: { session_id: z.string() },
        run: async (a: { session_id: string }) => {
          const [id, c] = this.ownChild(chat, a.session_id);
          const look = await s.open(id);
          const reply = lastReply(await s.recent(id, 30));
          return [
            `Session ${id} ("${look.summary.title || "Untitled"}", ${look.summary.projectPath})`,
            `Status: ${look.status}${look.state.error ? `, last error: ${look.state.error}` : ""}`,
            look.requests.length ? `Waiting for the person on ${look.requests.length} request${look.requests.length === 1 ? "" : "s"}.` : "",
            look.state.queue.length ? `${look.state.queue.length} message${look.state.queue.length === 1 ? "" : "s"} queued.` : "",
            c.released === "person" ? "The person has taken this session over: leave it to them." : c.released === "limit" ? "You've stopped following it (report limit)." : `Reports so far: ${c.reports} of ${MAX_REPORTS}.`,
            reply ? `Latest reply:\n${cut(reply, REPLY_MAX)}` : "No reply yet.",
          ]
            .filter(Boolean)
            .join("\n");
        },
      },
      {
        name: "send_to_session",
        description: "Sends a message to a session you started: it goes now if the session is idle, else after its current turn.",
        input: { session_id: z.string(), message: z.string().min(1) },
        run: async (a: { session_id: string; message: string }) => {
          const [id, c] = this.ownChild(chat, a.session_id);
          if (c.released === "person") throw new Error("The person has taken this session over. Leave it to them.");
          if (c.released === "limit") throw new Error(`This session has sent ${MAX_REPORTS} reports; you've stopped following it. Tell the person where it stands.`);
          await s.queue(id, FROM_TETHER + a.message);
          return "Sent. You'll get a report when it finishes the turn.";
        },
      },
    ];
  }

  setup(nativeId: string): AgentSetup {
    return {
      server: "tether",
      tools: this.tools(nativeId),
      instructions: INSTRUCTIONS,
      // No shell, no edits, nothing from the network, no subagents: the sessions it starts do the work.
      deny: ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent"],
    };
  }

  /** Tells a chat about one of its sessions, through its queue (after its own turn, if one runs). */
  private async report(id: string, c: Child, body: string) {
    try {
      await this.ctx.sessions.queue(c.chat, FROM_TETHER + body);
    } catch (e) {
      this.ctx.log(`couldn't report ${id} to ${c.chat}: ${(e as Error).message}`);
    }
  }

  private async describe(id: string) {
    const look = await this.ctx.sessions.open(id).catch(() => undefined);
    return look ? `Session ${id} ("${look.summary.title || "Untitled"}" in ${look.summary.projectPath}, ${AGENT_NAMES[look.summary.harness] ?? look.summary.harness})` : `Session ${id}`;
  }

  async turnEnded(id: string, error?: string, stopped?: boolean) {
    const c = this.state.children[id];
    if (!c || c.released) return;
    if (stopped) {
      // The person pressed Stop: it's theirs now.
      c.released = "person";
      this.save();
      return;
    }
    c.reports++;
    const last = c.reports >= MAX_REPORTS;
    if (last) c.released = "limit";
    this.save();
    const reply = lastReply(await this.ctx.sessions.recent(id, 30).catch(() => [] as Msg[]));
    const lines = [
      `${await this.describe(id)} finished a turn${error ? ` with an error: ${error}` : "."}`,
      reply ? `Its last reply:\n<<<\n${cut(reply, REPLY_MAX)}\n>>>` : "It said nothing.",
      last
        ? `That's report ${MAX_REPORTS} of ${MAX_REPORTS}: you've stopped following this session and can't message it any more. Tell the person where it stands.`
        : `Report ${c.reports} of ${MAX_REPORTS}. Keep it going with send_to_session if the task isn't done, or tell the person.`,
    ];
    await this.report(id, c, lines.join("\n\n"));
  }

  async needsPerson(id: string, what: string) {
    const c = this.state.children[id];
    if (!c || c.released) return;
    await this.report(id, c, `${await this.describe(id)} is waiting for the person: ${what}. Only they can answer it, in that session. Tell them briefly.`);
  }

  /** Someone typed into a session the agent started: it's theirs from now. */
  personSpoke(id: string, msg: Msg) {
    const c = this.state.children[id];
    if (!c || c.released || msg.role !== "user" || msg.origin?.kind === "tether") return;
    // A harness that hasn't parsed the marker yet shows Tether's own text as it was sent.
    if (msg.parts.some((p) => p.type === "text" && p.text.startsWith(FROM_TETHER))) return;
    c.released = "person";
    this.save();
  }
}

export const homeAgentModule: Module = {
  name: "homeAgent",
  start(ctx) {
    const folder = ctx.homeFolder;
    const claude = ctx.sessions.adapters().find((a) => a.id === "claude");
    if (!folder || !existsSync(folder) || !claude?.agentSetup) return;
    const agent = new HomeAgent(ctx, folder);
    const unset = claude.agentSetup(folder, (nativeId) => agent.setup(nativeId));

    ctx.ops.register("homeAgent", async () => ({ sessionId: await agent.current(), folder }));
    ctx.ops.register("homeAgentNew", async () => ({ sessionId: await agent.newChat() }));

    const offs = [
      ctx.bus.on("turnEnded", ({ sessionId, error, stopped }) => void agent.turnEnded(sessionId, error, stopped)),
      ctx.bus.on("message", ({ sessionId, msg }) => agent.personSpoke(sessionId, msg)),
      ctx.bus.on("requestOpened", ({ request }) => void agent.needsPerson(request.sessionId, request.title || request.question || (request.tool ? `permission for ${request.tool}` : "a question"))),
      ctx.bus.on("attention", ({ sessionId, message }) => void agent.needsPerson(sessionId, message || "in its terminal")),
    ];
    return () => {
      unset();
      offs.forEach((off) => off?.());
    };
  },
};
