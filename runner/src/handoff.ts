// The brief a new agent gets when a conversation moves to another harness (usage limit hit, or
// an earlier chain entry reset). Native histories can't be transplanted between harnesses, so
// we render the harness-neutral transcript plus the repository state. Files are shared: the
// new agent works in the same directory.

import { splitAgentWritten } from "../../web/src/shared/subagents";
import { AGENT_LABEL, userLabel } from "./goal";
import { withAttachments } from "../../web/src/shared/attachments";
import type { ActivityItem, Msg, Part, UiRequest } from "../../web/src/shared/protocol";
import { commandOf } from "./guard";

const MAX_CHARS = 60_000;
const ASSISTANT_TEXT_MAX = 4_000;
const TOOL_OUT_MAX = 400;

function clip(s: string, n: number) {
  s = s.trim();
  return s.length > n ? s.slice(0, n) + ` … [${s.length - n} more chars]` : s;
}

function toolLine(name: string, input: any, status: string, output?: string): string {
  const arg =
    input?.command ?? input?.cmd ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.url ?? input?.description ?? "";
  const head = `- [${name}${status === "error" ? ", failed" : ""}] ${clip(String(arg), 200)}`;
  const out = output ? clip(output, TOOL_OUT_MAX).replace(/\n/g, "\n    ") : "";
  return out ? `${head}\n    → ${out}` : head;
}

export function renderTranscript(messages: Msg[]): string {
  const blocks: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      // Attached files keep their paths (the new agent can open them, and the target harness gets
      // the images natively when it can); a stored image that came with them is the same file.
      const files = m.parts.filter((p): p is Extract<Part, { type: "file" }> => p.type === "file");
      const text = m.parts
        .map((p) => (p.type === "text" ? p.text : p.type === "image" ? (files.length ? "" : "[image]") : p.type === "skill" ? `[ran the /${p.name} skill]` : ""))
        .join("\n")
        .trim();
      const all = withAttachments(text, files.map(({ type: _, ...f }) => f));
      // Tether's notes about subagents and another agent's messages aren't the user's.
      const { user, agent } = splitAgentWritten(all);
      if (user) blocks.push(`### ${userLabel(user)}\n${user}`);
      if (agent) blocks.push(`### ${AGENT_LABEL}\n${agent}`);
    } else if (m.role === "assistant") {
      const lines: string[] = [];
      for (const p of m.parts) {
        if (p.type === "text" && p.text.trim()) lines.push(clip(p.text, ASSISTANT_TEXT_MAX));
        else if (p.type === "tool") lines.push(toolLine(p.name, p.input, p.status, p.output));
        else if (p.type === "plan" && p.text.trim()) lines.push(`Plan${p.outcome === "approved" ? " (approved)" : ""}:\n${clip(p.text, ASSISTANT_TEXT_MAX)}`);
      }
      if (m.error) lines.push(`(this turn ended with an error: ${clip(m.error, 300)})`);
      if (lines.length) blocks.push(`### Agent${m.model ? ` (${m.model})` : ""}\n${lines.join("\n")}`);
    } else if (m.role === "notice") {
      const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim();
      if (text) blocks.push(`> ${clip(text, 600)}`);
    }
  }
  // Keep the first user request and as much of the recent conversation as fits.
  let out = blocks.join("\n\n");
  if (out.length > MAX_CHARS && blocks.length > 2) {
    const first = blocks[0]!;
    const tail: string[] = [];
    let size = first.length + 200;
    for (let i = blocks.length - 1; i > 0 && size + blocks[i]!.length < MAX_CHARS; i--) {
      tail.unshift(blocks[i]!);
      size += blocks[i]!.length + 2;
    }
    out = [first, `[… ${blocks.length - 1 - tail.length} earlier entries omitted …]`, ...tail].join("\n\n");
  }
  return out;
}

async function sh(cwd: string, cmd: string[]): Promise<string> {
  try {
    const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "ignore" });
    const text = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? text.trim() : "";
  } catch {
    return "";
  }
}

export async function repoState(cwd: string): Promise<string> {
  const branch = await sh(cwd, ["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) return "(not a git repository)";
  const [status, stat, log] = await Promise.all([
    sh(cwd, ["git", "status", "--short"]),
    sh(cwd, ["git", "diff", "--stat", "HEAD"]),
    sh(cwd, ["git", "log", "--oneline", "-5"]),
  ]);
  return [
    `Branch: ${branch}`,
    `Recent commits:\n${log || "(none)"}`,
    `Uncommitted changes (git status --short):\n${clip(status || "(clean)", 4000)}`,
    stat ? `Diff stat:\n${clip(stat, 4000)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** One cancelled approval or question, as the brief lists it. */
export function describeRequest(r: UiRequest): string {
  if (r.kind === "permission" && r.tool) {
    const what = commandOf(r.tool.input) ?? JSON.stringify(r.tool.input ?? {});
    return `Approval for ${r.tool.name}: ${clip(what, 300)}`;
  }
  if (r.kind === "question" && r.questions?.length) return `Question: ${r.questions.map((q) => q.question).join(" / ")}`;
  if (r.kind === "plan") return "Review of its plan";
  return [r.title, r.message].filter(Boolean).map((t) => clip(t!, 300)).join(": ");
}

/** One background task of the old session, as the brief lists it. */
export function describeTask(a: ActivityItem): string {
  const kind = a.kind === "subagent" ? `subagent${a.agentType ? ` (${a.agentType})` : ""}` : a.kind;
  const what = a.command ?? a.watching ?? a.title;
  const extra = a.description && a.description !== what ? ` — ${clip(a.description, 300)}` : "";
  const when = a.schedule ? ` (${a.schedule})` : "";
  return `${kind}: ${clip(what, 300)}${when}${extra}`;
}

/** How every brief starts. Some harnesses show the brief (or its start) as a user message. */
export const BRIEF_PREFIX = "You are taking over an in-progress coding session";
export const isBrief = (m: Msg) => m.role === "user" && m.parts.some((p) => p.type === "text" && p.text.trimStart().startsWith(BRIEF_PREFIX));

export async function buildBrief(opts: {
  messages: Msg[];
  cwd: string;
  fromLabel: string;
  reason: string;
  pendingPrompt?: string;
  /** the master context's memory section (context/handoff.ts); absent when the context is off */
  memory?: string;
  /** the previous agent stopped in the middle of its task (a usage limit or an error) */
  interrupted?: boolean;
  /** approvals and questions that were open on the old session and got cancelled */
  cancelled?: UiRequest[];
  /** the old session's background tasks; `stopped` false: Tether couldn't stop it */
  tasks?: { item: ActivityItem; stopped: boolean }[];
  /** the session's active goal (goal.ts briefSection), which carries over */
  goal?: string;
  /** the session's plan and todo list (plan.ts briefSection), which carry over */
  plan?: string;
  /**
   * handoff (default): another agent takes the conversation over. fork: a new conversation that
   * branches off at the last message given (fork.ts). compact: the same conversation restarted to
   * free up context (`/compact` where the harness can't compact itself).
   */
  kind?: "handoff" | "fork" | "compact";
  /** fork: the original conversation went on after the point it was forked at */
  later?: boolean;
  /** compact: what the user asked to keep in focus */
  focus?: string;
}): Promise<string> {
  const transcript = renderTranscript(opts.messages);
  const repo = await repoState(opts.cwd);
  const memory = opts.memory?.trim() ? `\n## Memory\n${opts.memory.trim()}\n` : "";
  const open: string[] = [];
  if (opts.interrupted)
    open.push(
      "The previous agent was interrupted in the middle of its task, possibly halfway through an edit or a command. Before you continue, inspect the working tree (`git status`, `git diff`) and check that the files it was changing are complete and consistent.",
    );
  if (opts.cancelled?.length)
    open.push(
      `These requests were still open on the old session and have been cancelled, unanswered:\n${opts.cancelled.map((r) => `- ${describeRequest(r)}`).join("\n")}\nAsk again if you still need them.`,
    );
  const stopped = opts.tasks?.filter((t) => t.stopped) ?? [];
  const running = opts.tasks?.filter((t) => !t.stopped) ?? [];
  if (stopped.length)
    open.push(`These background tasks of the previous agent were stopped:\n${stopped.map((t) => `- ${describeTask(t.item)}`).join("\n")}\nRestart the ones that are still needed.`);
  if (running.length)
    open.push(
      `These background tasks of the previous agent could not be stopped and may still be running:\n${running.map((t) => `- ${describeTask(t.item)}`).join("\n")}\nCheck on them before starting the same work again.`,
    );
  const interrupted = open.length ? `\n## Interrupted work\n${open.join("\n\n")}\n` : "";
  const goal = opts.goal?.trim() ? `\n## Goal\n${opts.goal.trim()}\n` : "";
  const plan = opts.plan?.trim() ? `\n## Plan\n${opts.plan.trim()}\n` : "";
  const kind = opts.kind ?? "handoff";
  const focus = opts.focus?.trim() ? `\n## Focus\nThe user asked to keep this in focus: ${opts.focus.trim()}\n` : "";
  const head =
    kind === "fork"
      ? `${BRIEF_PREFIX}, forked from a conversation with another agent (${opts.fromLabel}): ${opts.reason}. The conversation below ends at the point the user forked it.${
          opts.later ? " The original conversation went on after that point, so the files on disk may include changes made later: check the repository state below and re-read files before you rely on them." : ""
        }`
      : kind === "compact"
        ? `${BRIEF_PREFIX} from an earlier session of your own (${opts.fromLabel}), restarted to free up context. You are the same agent, continuing the same work with a fresh context.`
        : `${BRIEF_PREFIX} from another agent (${opts.fromLabel}). It stopped because: ${opts.reason}.`;
  const next = opts.pendingPrompt
    ? `The user's new message:\n\n${opts.pendingPrompt}`
    : opts.interrupted
      ? "Inspect the working tree first, then continue the task from where the previous agent stopped. Don't redo finished work."
      : kind === "fork"
        ? "Don't start any work yet. Say in a sentence or two where the conversation stands, then wait for the user's next message."
        : kind === "compact"
          ? `Don't start new work. Sum up where things stand in a few lines${opts.focus?.trim() ? ", with the focus above in mind" : ""}, then wait for the user's next message.`
          : "Continue the task from exactly where the previous agent stopped. Don't redo finished work; check the repository state first if unsure.";
  return `${head}
You are in the same working directory (${opts.cwd}); every change made so far is already on disk. Tool outputs below are truncated, so re-read files before editing them.
${memory}
## Conversation so far
${transcript || "(empty)"}

## Repository state now
${repo}
${interrupted}${goal}${plan}${focus}
## What to do
${next}`;
}
