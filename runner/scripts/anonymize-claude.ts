// Turns a real Claude Code session JSONL into a fixture: the chain structure (uuids, parents,
// types, compaction boundaries, flags, timestamps) kept, every text replaced by a placeholder.
//   bun scripts/anonymize-claude.ts <in.jsonl> <out.jsonl>
import { readFileSync, writeFileSync } from "node:fs";
const [inp, out] = process.argv.slice(2);
let n = 0;
// Wrappers Claude Code adds (<system-reminder>, <command-name>…, interrupts) keep their opening tag.
const text = (s: unknown) => {
  if (typeof s !== "string") return s;
  if (s.startsWith("[Request interrupted")) return s;
  const tag = s.match(/^\s*<[\w-]+>/)?.[0];
  return tag ? `${tag}x` : `text ${++n}`;
};
function block(b: any): any {
  if (!b || typeof b !== "object") return b;
  switch (b.type) {
    case "text": return { type: "text", text: text(b.text) };
    case "thinking": return { type: "thinking", thinking: "" };
    case "tool_use": return { type: "tool_use", id: b.id, name: b.name, input: { command: `cmd ${++n}` } };
    case "tool_result": return { type: "tool_result", tool_use_id: b.tool_use_id, content: `output ${++n}`, ...(b.is_error ? { is_error: true } : {}) };
    default: return { type: b.type };
  }
}
const lines: string[] = [];
for (const line of readFileSync(inp!, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let e: any;
  try { e = JSON.parse(line); } catch { continue; }
  if (!e.uuid) continue;
  const o: any = { parentUuid: e.parentUuid ?? null, ...(e.logicalParentUuid ? { logicalParentUuid: e.logicalParentUuid } : {}), isSidechain: !!e.isSidechain, type: e.type, uuid: e.uuid, timestamp: e.timestamp };
  for (const k of ["isMeta", "isCompactSummary", "subtype"]) if (e[k] !== undefined) o[k] = e[k];
  if (e.message && (e.type === "user" || e.type === "assistant")) {
    const c = e.message.content;
    o.message = { role: e.message.role, ...(e.message.id ? { id: e.message.id } : {}), ...(e.message.model ? { model: e.message.model } : {}), content: typeof c === "string" ? (e.isCompactSummary ? "summary" : text(c)) : Array.isArray(c) ? c.map(block) : c };
  }
  lines.push(JSON.stringify(o));
}
writeFileSync(out!, lines.join("\n") + "\n");
console.log(`${lines.length} entries -> ${out}`);
