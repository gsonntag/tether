// `tether-context`: the master context as an MCP server, so any harness can search and write the
// shared memory and read the skill library.
//
//   bun runner/src/context/mcp.ts      (stdio; TETHER_CONTEXT_DIR points at the store)
//
// Reads come straight from the store. Writes don't touch memory files: memory_write drops the
// note in the store's inbox, and the runner's merge pass (dedupe, update, conflicts, commit)
// takes it from there, so every write goes through the same path as imported memory.
//
// The session tools act on the calling session: goal_get / goal_update on its goal (/goal,
// runner/src/goal.ts), plan_get / plan_set / todo_set on its plan (runner/src/plan.ts), and
// ask_user puts a question card in front of the user and waits for the answer; in a review
// session (/review, TETHER_CONTEXT_REVIEW=1) review_report hands in the findings; everywhere else
// the agent_* tools start and follow cross-harness subagents (runner/src/crossAgents.ts). They go to the
// runner over its loopback bridge (bridge.ts), as the session whose key is in the environment.
// With the master context off a session still gets this server, with only the session tools
// (TETHER_CONTEXT_TOOLS=goal, the name from when they were only the goal tools).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_TYPES, sha } from "./format";
import { bridgeFile } from "./launch";
import { contextDir } from "./paths";
import { repoKey } from "./repokey";
import { sections } from "./sources";
import { listSkills, readMeta, skillFile } from "./skills";
import { Store, writeAtomic } from "./store";

const TOOLS = [
  {
    name: "memory_search",
    description:
      "Search the user's shared long-term memory (preferences, feedback, project facts) kept by Tether across all coding agents. Searches global memory and this repository's memory by default.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for" },
        scope: { type: "string", enum: ["all", "global", "repo"], description: "global: about the user; repo: this repository; all (default): both" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_get",
    description: "Read one memory entry in full, by the id or name memory_search returned.",
    inputSchema: { type: "object", properties: { slug: { type: "string", description: "id (e.g. global/user-role) or name" } }, required: ["slug"] },
  },
  {
    name: "memory_write",
    description:
      "Save one durable fact to the shared memory (a user preference, a correction to how agents should work, a non-obvious project fact). One fact per call, self-contained. It is merged with existing memory (duplicates and contradictions are handled).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The fact, as a short markdown note" },
        type: { type: "string", enum: MEMORY_TYPES, description: "user: who they are; feedback: how they want agents to work; project: about this project; reference: pointer to docs" },
        scope: { type: "string", enum: ["global", "repo"], description: "global: true everywhere; repo: only this repository. Omit to let Tether decide." },
      },
      required: ["text"],
    },
  },
  { name: "skill_list", description: "List the skills in the user's shared skill library.", inputSchema: { type: "object", properties: {} } },
  {
    name: "skill_get",
    description: "Read a skill's instructions (SKILL.md) from the shared library, plus the list of its supporting files.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
];

export const GOAL_TOOLS = [
  {
    name: "goal_get",
    description: "Read this session's goal (set by the user with /goal in Tether): the objective, its status, the budget used and the latest progress notes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "goal_update",
    description:
      "Report progress on this session's goal. status: \"active\" with a note to record progress and keep going; \"done\" only when the objective is fully achieved and verified (Tether double-checks the claim against the conversation); \"blocked\" when you can't go on without the user (say why in the note); \"paused\" only if the user asked you to pause.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "done", "blocked", "paused"], description: "active (default): still working; done: achieved; blocked: needs the user; paused: the user asked" },
        note: { type: "string", description: "What you did or found, or why you're blocked: one or two sentences" },
      },
      required: ["note"],
    },
  },
];

export const PLAN_TOOLS = [
  {
    name: "plan_get",
    description: "Read this session's plan and todo list as Tether keeps them (they carry over when the session moves to another agent), and whether the user approved the plan.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "plan_set",
    description:
      "Write or replace this session's plan, as markdown: what you'll change and how, step by step. The user sees it in Tether. In plan mode, call this with your plan and then end your turn: the user reviews it and either approves it (then you carry it out) or sends feedback.",
    inputSchema: { type: "object", properties: { markdown: { type: "string", description: "The whole plan, as markdown" } }, required: ["markdown"] },
  },
  {
    name: "todo_set",
    description: "Replace this session's todo list, shown to the user as a checklist. Send the whole list each time, with each item's status; keep exactly one item in_progress while you work.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { text: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } },
            required: ["text", "status"],
          },
        },
      },
      required: ["items"],
    },
  },
];

export const ASK_TOOLS = [
  {
    name: "ask_user",
    description:
      "Ask the user a question and wait for the answer: a question card in Tether, on their phone too. Use it when you can't reasonably decide yourself (a choice between approaches, missing information). Offer options when there are clear choices; the user can always answer in their own words. If nobody answers in time, you're told so: then decide yourself and say what you chose.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "One clear question" },
        options: { type: "array", items: { type: "string" }, description: "Short answers to pick from (optional)" },
        multiSelect: { type: "boolean", description: "The user may pick several options" },
      },
      required: ["question"],
    },
  },
];

const severity = { type: "string", enum: ["critical", "high", "medium", "low"], description: "critical: data loss, security hole, crash on a main path; high: a real bug; medium: an edge case or a risk; low: minor" };

/** Only in a review session (/review, TETHER_CONTEXT_REVIEW=1): how the reviewer hands in its findings. */
export const REVIEW_TOOLS = [
  {
    name: "review_report",
    description:
      "Report your review's findings to the user, once, when you're done: every finding with its file, line, severity, issue and fix, and a one-line summary. An empty list is fine if the changes look right. The user sees them in the session you reviewed and can send each one to its agent to fix.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Your verdict in one line" },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file: { type: "string", description: "Path relative to the working directory" },
              line: { type: "integer", description: "Line in the file as it is now" },
              severity,
              issue: { type: "string", description: "What's wrong and why it matters" },
              fix: { type: "string", description: "What to change" },
            },
            required: ["file", "severity", "issue", "fix"],
          },
        },
      },
      required: ["findings"],
    },
  },
];

const agentId = { type: "string", description: "The subagent's id (its name, as agent_start returned it)" };

/**
 * Cross-harness subagents (runner/src/crossAgents.ts): start another coding agent on any installed
 * harness and model as a Tether session of its own, follow it, and take its work. Not in a review session.
 */
export const AGENT_TOOLS = [
  {
    name: "agent_harnesses",
    description:
      "List the coding agents (harnesses) installed on this machine that you can start as subagents through Tether, with each one's models (the exact ids agent_start takes), effort levels and modes, plus the guard levels you may give them. Call it before agent_start when the user names a harness or model, or asks what's available.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agent_start",
    description:
      "Start a subagent: another coding agent on any installed harness (claude-code, codex, pi, opencode, kiro, antigravity) and model, as its own Tether session the user can watch. Use it when the user asks for a specific agent or model (\"use a Kiro subagent on Sonnet to write the tests\"), or to run independent work in parallel on a different harness. (For a quick helper in your own harness, your own subagent tool is fine.) The subagent doesn't see your conversation: give it a self-contained task (goal, files, constraints, how to check its work). By default it works in its own git worktree on a new branch from your HEAD (your uncommitted changes are not in it); cwd \"shared\" runs it in your folder. Tether messages you when its turn ends; then use agent_result to read its report and diff, verify (run the tests), and merge its branch or cherry-pick.",
    inputSchema: {
      type: "object",
      properties: {
        harness: { type: "string", description: "claude-code, codex, pi, opencode, kiro or antigravity (default: your own). See agent_harnesses." },
        model: { type: "string", description: "A model id that harness lists (agent_harnesses), e.g. pi's provider/model. Default: the harness's default." },
        effort: { type: "string", description: "Effort / thinking level, one the harness lists" },
        mode: { type: "string", description: "The harness's mode (e.g. plan), one it lists" },
        task: { type: "string", description: "What to do, self-contained" },
        name: { type: "string", description: "A short name (becomes its id and branch name), e.g. write-tests" },
        cwd: { type: "string", enum: ["worktree", "shared"], description: "worktree (default in git repos): its own worktree and branch; shared: your folder" },
        guard: { type: "string", enum: ["ask", "edits", "auto", "full"], description: "Who approves its tool calls; default and loosest allowed: yours" },
      },
      required: ["task"],
    },
  },
  {
    name: "agent_status",
    description: "A subagent's state (working, waiting for the user, finished, failed, stopped), what it's doing now, how long it has run, tokens and cost when known, and questions it's waiting on.",
    inputSchema: { type: "object", properties: { id: agentId } },
  },
  {
    name: "agent_wait",
    description:
      "Wait until one of your subagents finishes its turn (or needs the user), for at most timeoutSec (100 at most). With no id or ids, waits for any working one. Returns its state and the start of its report. You don't have to wait: Tether messages you when one finishes, so you can keep working or end your turn.",
    inputSchema: {
      type: "object",
      properties: {
        id: agentId,
        ids: { type: "array", items: { type: "string" }, description: "Several subagents: returns when the first one is done" },
        timeoutSec: { type: "number", description: "Seconds to wait, 1-100 (default 100)" },
      },
    },
  },
  {
    name: "agent_message",
    description:
      "Send a subagent a message: steer (default) folds it into its running turn, or starts a turn if it's idle; queue waits until its turn ends; force interrupts it and sends this now. Use it to correct course, answer what it reported, or give it follow-up work. Its questions to the user are for the user: don't answer them for them.",
    inputSchema: {
      type: "object",
      properties: { id: agentId, text: { type: "string" }, mode: { type: "string", enum: ["steer", "queue", "force"] } },
      required: ["text"],
    },
  },
  {
    name: "agent_result",
    description:
      "A subagent's work: its final report (its last reply), the files it changed with a diff (cut short when long) against where it started, the commits on its branch, its worktree and branch, and how to take its work (merge or cherry-pick). Verify before you rely on it: read the diff and run the tests.",
    inputSchema: { type: "object", properties: { id: agentId } },
  },
  {
    name: "agent_stop",
    description: "Stop a subagent's running turn (and its own subagents). Its session and worktree stay.",
    inputSchema: { type: "object", properties: { id: agentId } },
  },
  { name: "agent_list", description: "Your subagents and their states.", inputSchema: { type: "object", properties: {} } },
];

const reviewing = () => process.env.TETHER_CONTEXT_REVIEW === "1";
const sessionHint = () =>
  `its goal (/goal) with goal_get and goal_update; its plan and todo list with plan_get, plan_set and todo_set; questions to the user with ask_user${reviewing() ? "; your review's findings with review_report" : "; cross-harness subagents with agent_harnesses and agent_start (any installed coding agent and model, e.g. a Kiro or Codex subagent, in its own worktree), followed with agent_status / agent_wait and taken with agent_result: verify its work (read the diff, run the tests) before you merge its branch or cherry-pick"}.`;

/** Tools that act on the calling session (through the runner), offered even while the master context is off. */
export const SESSION_TOOLS = [...GOAL_TOOLS, ...PLAN_TOOLS, ...ASK_TOOLS];
const SESSION_NAMES = new Set([...SESSION_TOOLS, ...REVIEW_TOOLS, ...AGENT_TOOLS].map((t) => t.name));

/** The tools this server lists: only the session tools while the master context is off; review_report only in a review session, the agent tools everywhere else. */
export const tools = () => {
  const session = reviewing() ? [...SESSION_TOOLS, ...REVIEW_TOOLS] : [...SESSION_TOOLS, ...AGENT_TOOLS];
  return process.env.TETHER_CONTEXT_TOOLS === "goal" ? session : [...TOOLS, ...session];
};

/** How often a waiting ask_user tells the client it's still alive (clients time out silent calls). */
export const timing = { progressMs: 30_000 };

/**
 * Calls a session tool in the runner, over its loopback bridge. ask_user waits as long as the user
 * takes (or `signal` says the client gave up); the others answer at once.
 */
async function sessionCall(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
  const what = tool.startsWith("goal") ? "the goal" : tool === "ask_user" ? "the question" : tool === "review_report" ? "the review" : tool.startsWith("agent_") ? "the subagent" : "the plan";
  if (tool.startsWith("agent_") && reviewing()) return fail("A review session can't start subagents.");
  const key = process.env.TETHER_SESSION_KEY ?? process.env.TETHER_GUARD_KEY;
  if (!key) return fail(tool.startsWith("goal") ? "Goals work only in sessions Tether started." : "This works only in sessions Tether started.");
  // The session's own file (address + token); a global registration (Antigravity) reads the shared
  // address and takes its token from the environment its harness passed through.
  let bridge: { url: string; token?: string };
  try {
    bridge = JSON.parse(readFileSync(process.env.TETHER_BRIDGE_FILE ?? bridgeFile(), "utf8"));
  } catch {
    return fail(`Tether's runner isn't reachable from here, so ${what} can't be reached.`);
  }
  const waits = tool === "ask_user";
  // agent_wait blocks up to 100 s; agent_start makes a worktree and starts a harness; agent_result reads git.
  const limitMs = tool === "agent_wait" ? 130_000 : tool === "agent_start" || tool === "agent_harnesses" ? 180_000 : tool.startsWith("agent_") ? 60_000 : 15_000;
  const res = await fetch(`${bridge.url}/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.token ?? process.env.TETHER_GUARD_TOKEN ?? ""}`, "content-type": "application/json" },
    body: JSON.stringify({ key, tool, args }),
    signal: waits ? signal : AbortSignal.any([AbortSignal.timeout(limitMs), ...(signal ? [signal] : [])]),
    // Bun's own fetch timeout would end a question the user is still reading (or a long agent_wait).
    ...(waits || limitMs > 15_000 ? { timeout: false } : {}),
  } as RequestInit).catch(() => undefined);
  if (!res?.ok) return fail(`Tether's runner didn't answer; ${what} is unchanged.`);
  const r: any = await res.json().catch(() => ({}));
  return r.ok ? ok(String(r.text ?? "")) : fail(String(r.text ?? "Tether refused the call."));
}

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

/** The repo's own CLAUDE.md / AGENTS.md: searchable context, not memory. */
function repoDocs(cwd: string, query: string): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const out: string[] = [];
  for (const f of ["CLAUDE.md", "AGENTS.md"]) {
    const p = join(cwd, f);
    if (!existsSync(p)) continue;
    for (const s of sections(readFileSync(p, "utf8"))) {
      const text = `${s.title}\n${s.body}`.toLowerCase();
      if (terms.length && terms.some((t) => text.includes(t))) out.push(`[${f}${s.title ? ` › ${s.title}` : ""}]\n${s.body.slice(0, 800)}`);
    }
  }
  return out.slice(0, 3);
}

export async function callTool(name: string, args: any, cwd = process.cwd(), signal?: AbortSignal): Promise<Result> {
  if (SESSION_NAMES.has(name)) return sessionCall(name, args && typeof args === "object" ? args : {}, signal);
  if (!tools().some((t) => t.name === name)) return fail(`Unknown tool ${name}`);
  const store = new Store(contextDir());
  switch (name) {
    case "memory_search": {
      const query = String(args?.query ?? "");
      const key = `repo:${await repoKey(cwd)}`;
      const scope = args?.scope === "global" ? ["global"] : args?.scope === "repo" ? [key] : ["global", key];
      const hits = store.search(query, scope, 10);
      const docs = scope.includes(key) ? repoDocs(cwd, query) : [];
      if (!hits.length && !docs.length) return ok("No matching memory.");
      const lines = hits.map((m) => `- ${m.id} (${m.type}, ${m.scope}): ${m.description}\n  ${m.body.replace(/\s+/g, " ").slice(0, 240)}`);
      if (docs.length) lines.push("", "From this repository's own docs:", ...docs);
      return ok(lines.join("\n"));
    }
    case "memory_get": {
      const want = String(args?.slug ?? "").trim();
      const key = `repo:${await repoKey(cwd)}`;
      const all = store.list();
      const rank = (s: string) => (s === key ? 0 : s === "global" ? 1 : 2);
      const m = all.find((x) => x.id === want) ?? all.filter((x) => x.slug === want || x.name === want).sort((a, b) => rank(a.scope) - rank(b.scope))[0];
      if (!m) return fail(`No memory "${want}". Use memory_search to find ids.`);
      return ok(`# ${m.name}\n${m.description}\n\ntype: ${m.type} · scope: ${m.scope} · updated: ${m.updated}\n\n${m.body}`);
    }
    case "memory_write": {
      const text = String(args?.text ?? "").trim();
      if (!text) return fail("text is required");
      if (text.length > 8000) return fail("Too long: save one fact per call.");
      const key = await repoKey(cwd);
      const scope = args?.scope === "global" ? "global" : args?.scope === "repo" ? `repo:${key}` : undefined;
      const type = MEMORY_TYPES.includes(args?.type) ? args.type : undefined;
      const note = {
        text,
        type,
        scope,
        repo: key,
        sessionId: process.env.TETHER_SESSION_ID,
        // TETHER_GUARD_KEY: a harness with only a global registration (Antigravity) may pass its
        // environment through to MCP servers, which still ties the write to the session.
        sessionKey: process.env.TETHER_SESSION_KEY ?? process.env.TETHER_GUARD_KEY,
        ts: Date.now(),
      };
      writeAtomic(join(store.dir, "inbox", `${Date.now()}-${sha(text + Math.random())}.json`), JSON.stringify(note));
      return ok("Saved. Tether merges it into the shared memory shortly (duplicates and contradictions are handled there).");
    }
    case "skill_list": {
      const skills = listSkills(join(store.dir, "skills"), readMeta(join(store.dir, "skills.json"))).filter((s) => s.enabled);
      if (!skills.length) return ok("The skill library is empty.");
      return ok(skills.map((s) => `- ${s.name}: ${s.description ?? ""}`).join("\n"));
    }
    case "skill_get": {
      const n = String(args?.name ?? "");
      const p = skillFile(join(store.dir, "skills"), n);
      if (!p) return fail(`No skill "${n}". Use skill_list.`);
      const dir = join(store.dir, "skills", n.replace(/-tether$/, ""));
      const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f !== "SKILL.md");
      return ok(`${readFileSync(p, "utf8")}${files.length ? `\n\n---\nSupporting files in ${dir}:\n${files.map((f) => `- ${f}`).join("\n")}` : ""}`);
    }
  }
  return fail(`Unknown tool ${name}`);
}

/** Calls in progress, by JSON-RPC id: `notifications/cancelled` ends one (an ask_user still waiting). */
const inflight = new Map<string | number, AbortController>();

/**
 * One JSON-RPC message in, at most one reply out. `notify` sends notifications while a call runs:
 * progress every `timing.progressMs` on a call that waits (ask_user), when the client asked for progress.
 */
export async function handle(msg: any, notify?: (m: object) => void): Promise<object | undefined> {
  const id = msg?.id;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  switch (msg?.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "tether-context", version: "0.1.0" },
        instructions:
          process.env.TETHER_CONTEXT_TOOLS === "goal"
            ? `This session in Tether: ${sessionHint()}`
            : `The user's shared memory and skills across coding agents (Tether). Search before assuming; write durable facts back. This session: ${sessionHint()}`,
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: tools() });
    case "tools/call": {
      const ctl = new AbortController();
      if (id !== undefined && id !== null) inflight.set(id, ctl);
      const token = msg.params?._meta?.progressToken;
      let n = 0;
      const timer =
        token !== undefined && notify
          ? setInterval(() => notify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: ++n, message: "Waiting for the user" } }), timing.progressMs)
          : undefined;
      try {
        return reply(await callTool(String(msg.params?.name), msg.params?.arguments ?? {}, process.cwd(), ctl.signal));
      } catch (e: any) {
        return reply(fail(`tether-context error: ${e?.message ?? e}`));
      } finally {
        clearInterval(timer);
        if (id !== undefined && id !== null) inflight.delete(id);
      }
    }
    case "notifications/cancelled":
      inflight.get(msg.params?.requestId)?.abort();
      return undefined;
  }
  if (id === undefined || id === null) return undefined; // notification
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${msg?.method}` } };
}

if (import.meta.main) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
        continue;
      }
      // Not awaited: an ask_user waiting for the user mustn't hold up other calls (or their cancellation).
      const write = (m: object) => process.stdout.write(JSON.stringify(m) + "\n");
      void handle(msg, write).then((out) => out && write(out));
    }
  }
}
