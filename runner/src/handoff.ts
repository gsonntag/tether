// The brief a new agent gets when a conversation moves to another harness (usage limit hit, or
// an earlier chain entry reset). Native histories can't be transplanted between harnesses, so
// we render the harness-neutral transcript plus the repository state. Files are shared: the
// new agent works in the same directory.

import type { Msg } from "../../web/src/shared/protocol";

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
      const text = m.parts.map((p) => (p.type === "text" ? p.text : p.type === "image" ? "[image]" : "")).join("\n").trim();
      if (text) blocks.push(`### User\n${text}`);
    } else if (m.role === "assistant") {
      const lines: string[] = [];
      for (const p of m.parts) {
        if (p.type === "text" && p.text.trim()) lines.push(clip(p.text, ASSISTANT_TEXT_MAX));
        else if (p.type === "tool") lines.push(toolLine(p.name, p.input, p.status, p.output));
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

export async function buildBrief(opts: {
  messages: Msg[];
  cwd: string;
  fromLabel: string;
  reason: string;
  pendingPrompt?: string;
}): Promise<string> {
  const transcript = renderTranscript(opts.messages);
  const repo = await repoState(opts.cwd);
  return `You are taking over an in-progress coding session from another agent (${opts.fromLabel}). It stopped because: ${opts.reason}.
You are in the same working directory (${opts.cwd}); every change it made is already on disk. Its tool outputs below are truncated, so re-read files before editing them.

## Conversation so far
${transcript || "(empty)"}

## Repository state now
${repo}

## What to do
${
  opts.pendingPrompt
    ? `The user's new message:\n\n${opts.pendingPrompt}`
    : "Continue the task from exactly where the previous agent stopped. Don't redo finished work; check the repository state first if unsure."
}`;
}
