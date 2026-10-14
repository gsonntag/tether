// The session plan (Phase 4): one plan and todo list per Tether session, written through the
// `tether-context` tools plan_set / todo_set or taken from the harness's own plan and todo tools,
// carried across handoffs, and an approval gate on every harness:
//   - Claude Code and Antigravity review plans themselves (ExitPlanMode, agy's plan mode); kept.
//   - Codex and ACP agents have plan modes but no review step over their APIs: Tether shows the
//     plan for review when a plan-mode turn ends (or an ACP agent leaves plan mode by itself).
//   - pi has no modes: Tether's own "plan" mode, in which the guard denies anything that would
//     change something until the plan is approved.
// The session side lives in session.ts ("plan and todos"); these are the pure pieces.

import type { Msg, SessionPlan, TodoItem } from "../../web/src/shared/protocol";
import { commandOf, isContextTool, kindOf } from "./guard";

/** The mode name Tether's own plan mode goes by (pi), and how plan modes are recognised elsewhere. */
export const PLAN_MODE = "plan";
export const isPlanMode = (mode: string | undefined) => !!mode && /(^|[-_\s])plan(ning)?($|[-_\s])/i.test(mode);

/** What an approval sends: Codex's own wording for "Yes, implement this plan". */
export const IMPLEMENT_PROMPT = "Implement the plan.";

/** Goes with a message sent in Tether's plan mode (pi), which the harness itself knows nothing about. */
export const PLAN_HINT =
  "[Tether plan mode: explore and plan only; don't change anything yet. Write the plan with the plan_set tool (or as your reply) and end your turn; the user reviews it first.]";

/** A message as written, without the plan-mode note Tether added to it. */
export const withoutPlanHint = (text: string) => (text.endsWith(PLAN_HINT) ? text.slice(0, -PLAN_HINT.length).trimEnd() : text);

/** Why a call was held back in Tether's plan mode. */
export const PLAN_MODE_REASON =
  "Blocked: the session is in plan mode, so nothing may be changed yet. Read and explore as needed, then write your plan with the plan_set tool (or as your reply if you don't have it) and end your turn. The user reviews it; once they approve, plan mode ends and you carry it out.";

/** Why a call was held back while a plan waits for review. */
export const PLAN_WAIT_REASON =
  "Blocked: your plan hasn't been approved yet. Don't change anything until it is: end your turn now (with the plan written via plan_set, or as your reply) and wait for the user's review.";

const STATUSES: TodoItem["status"][] = ["pending", "in_progress", "completed"];
const MAX_TODOS = 100;

/** todo_set's `items`, checked: a list, or why not. Statuses take Claude/Codex spellings too. */
export function parseTodos(items: unknown): TodoItem[] | string {
  if (!Array.isArray(items)) return "items must be a list of { text, status }.";
  if (items.length > MAX_TODOS) return `At most ${MAX_TODOS} items.`;
  const out: TodoItem[] = [];
  for (const it of items) {
    const text = String((it as any)?.text ?? (it as any)?.content ?? (it as any)?.step ?? "").replace(/\s+/g, " ").trim();
    if (!text) return "Every item needs a text.";
    const raw = String((it as any)?.status ?? "pending").toLowerCase().replace(/[\s-]/g, "_");
    const status = raw === "inprogress" ? "in_progress" : raw === "done" || raw === "complete" ? "completed" : (raw as TodoItem["status"]);
    if (!STATUSES.includes(status)) return `status must be one of ${STATUSES.join(", ")}.`;
    out.push({ text: text.slice(0, 500), status });
  }
  return out;
}

/** The todos in a TodoWrite-shaped tool input (Claude Code's TodoWrite, Codex's plan updates as the adapter shows them). */
export function todosFromInput(input: any): TodoItem[] | undefined {
  if (!Array.isArray(input?.todos)) return undefined;
  const t = parseTodos(input.todos);
  return typeof t === "string" ? undefined : t;
}

/** The todo card's input: the same shape as Claude Code's TodoWrite, which the transcript renders. */
export const todoInput = (todos: TodoItem[]) => ({ todos: todos.map((t) => ({ content: t.text, status: t.status })) });

/** A markdown task list (ACP plan entries as the adapter shows them) back as todos. */
export function parseChecklist(md: string): TodoItem[] {
  const out: TodoItem[] = [];
  for (const line of md.split("\n")) {
    const m = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (!m) continue;
    const progress = /\s*_\(in progress\)_\s*$/;
    const text = m[2]!.replace(progress, "").trim();
    if (text) out.push({ text, status: m[1] !== " " ? "completed" : progress.test(m[2]!) ? "in_progress" : "pending" });
  }
  return out;
}

const STATUS_TEXT: Record<SessionPlan["status"], string> = {
  draft: "Not reviewed",
  review: "Waiting for the user's review",
  approved: "Approved by the user",
  feedback: "Sent back by the user with feedback",
};

const todoLine = (t: TodoItem) => `- [${t.status === "completed" ? "x" : " "}] ${t.text}${t.status === "in_progress" ? " (in progress)" : ""}`;

/** plan_get's answer. */
export function describePlan(p: SessionPlan | undefined): string {
  if (!p || (!p.text.trim() && !p.todos.length)) return "No plan yet. Write one with plan_set, and keep a todo list with todo_set.";
  const parts: string[] = [];
  if (p.text.trim()) parts.push(`Plan (${STATUS_TEXT[p.status].toLowerCase()}):\n\n${p.text.trim()}`);
  else parts.push("No plan text yet.");
  if (p.todos.length) parts.push(`Todo list:\n${p.todos.map(todoLine).join("\n")}`);
  return parts.join("\n\n");
}

/** The brief's "Plan" section on a handoff; undefined when there's nothing to carry. */
export function briefSection(p: SessionPlan | undefined): string | undefined {
  if (!p || (!p.text.trim() && !p.todos.length)) return undefined;
  const lines: string[] = [];
  if (p.text.trim()) {
    const status = p.status === "approved" ? "The user approved this plan; carry it on." : p.status === "feedback" ? "The user sent this plan back with feedback (see the conversation); revise it first." : "The user hasn't approved this plan yet.";
    lines.push(status, "", p.text.trim());
  }
  if (p.todos.length) lines.push(...(lines.length ? [""] : []), "Todo list:", ...p.todos.map(todoLine));
  lines.push("", "If you have Tether's plan_set and todo_set tools, keep them up to date as you go.");
  return lines.join("\n");
}

// ---------------- what plan mode holds back ----------------

const READ_ONLY_HEADS = new Set(
  (
    "ls cat head tail wc grep egrep fgrep rg ag sort uniq diff cmp echo printf pwd which whereis type file stat du df tree " +
    "basename dirname realpath readlink date true false test [ cd jq yq cut tr paste column nl comm fold find fd less more " +
    "od hexdump xxd strings md5sum sha256sum sha1sum printenv uname whoami id ps cloc tokei"
  ).split(" "),
);
const GIT_READ = new Set("status diff log show blame ls-files ls-tree rev-parse grep describe shortlog reflog cat-file show-ref merge-base".split(" "));
const GIT_LISTING = new Set(["branch", "tag", "remote", "stash", "worktree", "config"]);

/** Readers that write a file with these arguments (`sort -o out`, `date -s`, …): their positional arguments past `files` are written to. */
const WRITES: Record<string, { flag?: RegExp; files?: number }> = {
  sort: { flag: /^(-[^-]*o|--output)/ },
  tree: { flag: /^(-[^-]*[oR]|--output)/ },
  date: { flag: /^(-[^-]*s|--set)/ },
  yq: { flag: /^(-[^-]*i|--inplace)/ },
  file: { flag: /^(-[^-]*C|--compile)/ },
  cloc: { flag: /^--(out|report-file|sql)/ },
  uniq: { files: 1 }, // uniq [in [out]]
  xxd: { files: 1 }, // xxd [in [out]]
};

/** A shell command that only reads: every segment a known reader, no redirect into a file, no substitution. */
export function readOnlyCommand(cmd: string): boolean {
  if (/\$\(|`|<\(|>\(/.test(cmd)) return false;
  // `>f`, `>>f`, `2>f`, `&>f` write a file; `2>&1`, `>&2` and /dev/null don't.
  for (const m of cmd.matchAll(/(?:^|[^<>])(?:\d*|&)>{1,2}\|?\s*(&?[^\s;&|<>]*)/g)) if (!m[1]!.startsWith("&") && m[1] !== "/dev/null") return false;
  for (const seg of cmd.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean)) {
    const t = [...seg.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
    while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]!)) t.shift();
    if (!t.length) continue;
    const head = t[0]!.split("/").pop()!;
    const args = t.slice(1);
    if (head === "git") {
      const sub = args.find((a) => !a.startsWith("-"));
      if (!sub) continue;
      // `git diff --output=x.patch` writes one.
      if (GIT_READ.has(sub) && !args.some((a) => a.startsWith("--output"))) continue;
      // `git branch`, `git tag -l`, `git stash list`, `git config --get x`: listing only.
      const rest = args.slice(args.indexOf(sub) + 1);
      if (GIT_LISTING.has(sub) && (sub === "stash" ? rest[0] === "list" || rest[0] === "show" : sub === "config" ? rest.some((a) => a === "--get" || a === "--list" || a === "-l") : rest.every((a) => a.startsWith("-") && !/^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force|set-upstream)/.test(a)))) continue;
      return false;
    }
    if (head === "find" && args.some((a) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(a))) return false;
    if (!READ_ONLY_HEADS.has(head)) return false;
    const w = WRITES[head];
    if (w?.flag && args.some((a) => w.flag!.test(a))) return false;
    if (w?.files !== undefined && args.filter((a) => a !== "-" && !a.startsWith("-")).length > w.files) return false;
  }
  return true;
}

/** A plan file the harness keeps in plan mode (opencode's `plans/*.md`, Claude Code's ~/.claude/plans). */
const PLAN_FILE = /(^|\/)plans\/[^/]+\.md$/;

/**
 * Whether plan mode holds this call back: anything that could change files or the outside world.
 * Reads, searches, web reads, bookkeeping (todos, subagent prompts are checked on their own),
 * Tether's own tools and plan files go through.
 */
export function mutates(tool: string, input: any): boolean {
  if (isContextTool(tool, input)) return false;
  // pi-mcp-adapter's proxy tool without a call or an action: status, search, describe, a server's
  // instructions (how the agent finds plan_set there). Connecting only Tether's own server.
  if (tool === "mcp" && !input?.tool && !input?.action && (!input?.connect || /^tether[-_]context$/.test(String(input.connect)))) return false;
  switch (kindOf(tool)) {
    case "read":
    case "web":
    case "meta":
      return false;
    case "edit": {
      const p = input?.file_path ?? input?.filePath ?? input?.path ?? input?.TargetFile;
      return !(typeof p === "string" && PLAN_FILE.test(p));
    }
    case "shell": {
      const cmd = commandOf(input);
      if (!cmd) return !/output|status/i.test(tool);
      return !readOnlyCommand(cmd);
    }
    default:
      return true;
  }
}

/** The last text the agent wrote since message `from`, and where it is (a plan written as a reply). */
export function lastReply(messages: Msg[], from: number): { msg: Msg; index: number; text: string } | undefined {
  for (let i = messages.length - 1; i >= Math.max(0, from); i--) {
    const m = messages[i]!;
    if (m.role === "user") return undefined;
    if (m.role !== "assistant") continue;
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const p = m.parts[j]!;
      if (p.type === "plan" && !p.checklist) return undefined;
      if (p.type === "text" && p.text.trim()) return { msg: m, index: j, text: p.text };
    }
  }
  return undefined;
}
