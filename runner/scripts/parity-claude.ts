// Drives real Claude (Haiku) through the adapter and checks that the live transcript is what the
// store reads back afterwards, so a session going stored doesn't reset its viewers.
//   bun scripts/parity-claude.ts [prompt…]
// (default: /context, a prompt, parallel tool calls, /compact, a prompt)
import { claudeAdapter } from "../src/adapters/claude";
import type { Sink } from "../src/core/adapter";
import { diffTranscripts, Transcript } from "../src/core/transcript";

// Claude Code stores parallel calls as a chain of entries, each result beside it (jsonl.ts).
const PARALLEL = "In ONE message, make three Bash tool calls in parallel: `echo one`, `echo two`, `echo three`. Then reply 'done'.";
const prompts = process.argv.slice(2).length ? process.argv.slice(2) : ["/context", "Say ok.", PARALLEL, "/compact", "Say done."];
const t = new Transcript();
let status = "idle";
const sink: Sink = {
  event: (e) => void t.apply(e),
  message: (id) => t.get(id),
  state: (p) => void (p.status && (status = p.status)),
  request: async () => ({ allow: true }),
  subagent: () => sink,
};
const id = crypto.randomUUID();
const dir = `${process.env.HOME}/.local/share/tether-dev/projects/scratch`;
const d = await claudeAdapter.start(dir, id, { model: "haiku", permissionMode: "bypassPermissions" }, sink);
for (const p of prompts) {
  await d.send(p);
  const t0 = Date.now();
  await Bun.sleep(500);
  while (status !== "idle" && Date.now() - t0 < 120_000) await Bun.sleep(200);
}
await d.close();
await Bun.sleep(500);
const stored = await claudeAdapter.readHistory(id, dir);
const diff = diffTranscripts(t.messages, stored);
const show = (ms: readonly any[]) => ms.map((m) => `${m.role}:${m.id.slice(0, 8)}:${JSON.stringify(m.parts[0]?.text ?? m.parts[0]?.type ?? "").slice(0, 40)}`);
console.log("session", id);
console.log("live  ", show(t.messages).join("\n       "));
console.log("stored", show(stored).join("\n       "));
console.log(diff.length ? `DIFFERENT: ${diff.map((e) => e.type === "msg" ? `msg ${e.msg.id}` : e.type).join(", ")}` : "SAME: going stored changes nothing");
process.exit(diff.length ? 1 : 0);
