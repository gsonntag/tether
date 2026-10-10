import type { Part } from "./protocol";
import { splitAttachments } from "./attachments";
import { splitSkills } from "./skill";

const BASH = /<bash-input>([\s\S]*?)<\/bash-input>\s*(?:<bash-stdout>([\s\S]*?)<\/bash-stdout>)?\s*(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?(?:\s*<bash-exit-code>[\s\S]*?<\/bash-exit-code>)?/g;

/**
 * Parts of a user prompt. Shell commands the person ran themselves (Claude Code's `!` mode, sent
 * as <bash-input>/<bash-stdout>/<bash-stderr>) become Bash tool cards; they never went through the
 * guard, so they carry a "you" verdict.
 */
export function userParts(text: string, msgId: string): Part[] {
  // Attached files (listed at the end of the message by the runner) show as chips and thumbnails.
  const att = splitAttachments(text);
  if (att.files.length) {
    const files: Part[] = att.files.map((f) => ({ type: "file", ...f }));
    return att.text ? [...textParts(att.text, msgId), ...files] : files;
  }
  return textParts(text, msgId);
}

function textParts(text: string, msgId: string): Part[] {
  // Skills sent inline (`/name` on a harness that can't run it, or pi's own `/skill:name`) show as
  // a chip; the request that came with them stays text.
  if (text.includes("<skill name=")) {
    const parts: Part[] = [];
    splitSkills(text).forEach((s, i) => {
      if (typeof s !== "string") parts.push({ type: "skill", name: s.name, location: s.location, content: s.content });
      else if (s.trim()) parts.push(...shellParts(s, `${msgId}:${i}`));
    });
    return parts;
  }
  return shellParts(text, msgId);
}

function shellParts(text: string, msgId: string): Part[] {
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
