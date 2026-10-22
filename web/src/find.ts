import type { Msg, Part } from "./shared/protocol";

/**
 * The text of a message as the find bar searches it: what a reader could see in the transcript
 * (text, thinking, a tool's name, command, path and output, a plan, a notice's title).
 */
export function messageText(m: Msg): string {
  const out: string[] = [];
  if (m.title) out.push(m.title);
  for (const p of m.parts) out.push(partText(p));
  if (m.error && m.error !== "aborted") out.push(m.error);
  return out.join("\n");
}

function partText(p: Part): string {
  switch (p.type) {
    case "text":
    case "thinking":
    case "plan":
      return p.text;
    case "tool":
      return [p.name, p.command, p.path, typeof p.input === "string" ? p.input : p.input == null ? "" : JSON.stringify(p.input), p.output, p.userRun?.output]
        .filter((s): s is string => !!s)
        .join("\n");
    case "skill":
      return `/${p.name}\n${p.content}`;
    case "file":
      return p.name;
    case "image":
      return "";
  }
}

/** Indices of the messages whose text contains `term` (case-insensitive substring), in order. */
export function findMessageIndices(messages: Msg[], term: string): number[] {
  const needle = term.toLowerCase();
  if (!needle) return [];
  const out: number[] = [];
  for (let i = 0; i < messages.length; i++) if (messageText(messages[i]!).toLowerCase().includes(needle)) out.push(i);
  return out;
}
