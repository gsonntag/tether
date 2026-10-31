// Records a real Agent SDK stream as a fixture: every SDKMessage as one JSONL line.
//   bun scripts/record-claude.ts <out.jsonl> <cwd> "<prompt>" [--interrupt-after-ms N] [--background-after-ms N] [--then "<message>"] [--model haiku]
// --background-after-ms: N ms after a foreground subagent starts, moves it to the background and
// (--then) sends a message.
// The adapter's tests replay these (src/adapters/claude/fixtures).
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync } from "node:fs";

const [out, cwd, prompt, ...rest] = process.argv.slice(2);
if (!out || !cwd || !prompt) throw new Error("usage: record-claude.ts out.jsonl cwd prompt [--interrupt-after-ms N] [--model m]");
const flag = (n: string) => {
  const i = rest.indexOf(n);
  return i >= 0 ? rest[i + 1] : undefined;
};
const interruptAfter = Number(flag("--interrupt-after-ms")) || 0;
const backgroundAfter = Number(flag("--background-after-ms")) || 0;
const then = flag("--then");
const model = flag("--model") ?? "haiku";

let wake: (() => void) | undefined;
const items: SDKUserMessage[] = [{ type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null } as SDKUserMessage];
let ended = false;
async function* input() {
  for (;;) {
    while (items.length) yield items.shift()!;
    if (ended) return;
    await new Promise<void>((r) => (wake = r));
  }
}

const q = query({
  prompt: input(),
  options: {
    cwd,
    model,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    forwardSubagentText: true,
    settingSources: ["user", "project", "local"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    env: { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
    pathToClaudeCodeExecutable: process.env.CLAUDE_BIN || Bun.which("claude") || undefined,
  },
});
const lines: string[] = [];
const t0 = Date.now();
if (interruptAfter) setTimeout(() => void q.interrupt().then(() => console.error("interrupted")), interruptAfter);
let backgrounding: ReturnType<typeof setTimeout> | undefined;
for await (const m of q) {
  lines.push(JSON.stringify(m));
  const started = m as any;
  if (backgroundAfter && !backgrounding && started.subtype === "task_started" && started.task_type === "local_agent" && !started.is_backgrounded) {
    backgrounding = setTimeout(() => {
      void q.backgroundTasks(started.tool_use_id).then((moved) => {
        console.error("backgrounded", moved);
        if (then) items.push({ type: "user", message: { role: "user", content: then }, parent_tool_use_id: null } as SDKUserMessage);
        wake?.();
      });
    }, backgroundAfter);
  }
  // The turn is over only when Claude Code says idle: background subagents can still be running after a result.
  if ((m as any).type === "system" && (m as any).subtype === "session_state_changed" && (m as any).state === "idle" && lines.some((l) => l.includes('"type":"result"'))) {
    ended = true;
    wake?.();
    break;
  }
}
q.close();
writeFileSync(out, lines.join("\n") + "\n");
console.error(`${lines.length} messages in ${Date.now() - t0} ms -> ${out}`);
