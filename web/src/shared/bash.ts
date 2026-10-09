import type { Part } from "./protocol";

const BASH = /<bash-input>([\s\S]*?)<\/bash-input>\s*(?:<bash-stdout>([\s\S]*?)<\/bash-stdout>)?\s*(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?(?:\s*<bash-exit-code>[\s\S]*?<\/bash-exit-code>)?/g;

/**
 * Parts of a user prompt. Shell commands the person ran themselves (Claude Code's `!` mode, sent
 * as <bash-input>/<bash-stdout>/<bash-stderr>) become Bash tool cards; they never went through the
 * guard, so they carry a "you" verdict.
 */
export function userParts(text: string, msgId: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(BASH)) {
    const before = text.slice(last, m.index).trim();
    if (before) parts.push({ type: "text", text: before });
    const [, command, stdout = "", stderr = ""] = m;
    parts.push({
      type: "tool",
      id: `${msgId}:bash${n++}`,
      name: "Bash",
      input: { command: command.trim() },
      status: "done",
      output: [stdout, stderr].map((s) => s.trimEnd()).filter(Boolean).join("\n"),
      guard: { decision: "allow", by: "user", reason: "Run by you directly, outside the guard" },
    });
    last = m.index! + m[0].length;
  }
  const rest = text.slice(last).trim();
  if (rest || !parts.length) parts.push({ type: "text", text: last ? rest : text });
  return parts;
}
