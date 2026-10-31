import { expect, test } from "bun:test";
import { historyMsgs } from "./items";
import { parsePrivateRollout } from "./offline";

const source = { id: "private", source: "openai" as const, projectPath: "/tmp" };
const line = (type: string, payload: any, i: number) => JSON.stringify({ timestamp: `2026-10-31T22:00:${String(i).padStart(2, "0")}Z`, ordinal: i, type, payload });
test("a stopped private daemon's native rollout still provides prompts, replies, reasoning, tool results and billing metadata", () => {
  const raw = [
    line("session_meta", { id: "thread", cwd: "/tmp", model_provider: "tether_openai", timestamp: "2026-10-31T22:00:00Z" }, 0),
    line("event_msg", { type: "task_started", turn_id: "turn" }, 1),
    line("event_msg", { type: "user_message", message: "Read it." }, 2),
    line("turn_context", { turn_id: "turn", model: "gpt-6-luna", effort: "low" }, 3),
    line("response_item", { type: "reasoning", id: "reason", summary: [{ type: "summary_text", text: "Checking." }] }, 4),
    line("response_item", { type: "function_call", call_id: "call", name: "exec_command", arguments: JSON.stringify({ cmd: "cat file" }) }, 5),
    line("event_msg", { type: "exec_command_end", call_id: "call", aggregated_output: "contents", exit_code: 0 }, 6),
    line("response_item", { type: "function_call_output", call_id: "call", output: "contents" }, 7),
    line("response_item", { type: "message", id: "reply", role: "assistant", content: [{ type: "output_text", text: "Done." }] }, 8),
    line("event_msg", { type: "task_complete", turn_id: "turn" }, 9),
  ].join("\n") + '\n{"torn":';
  const parsed = parsePrivateRollout(raw, "thread", source);
  expect(parsed.thread.modelProvider).toBe("tether_openai");
  expect(parsed.thread.preview).toBe("Read it.");
  expect(parsed.thread.model).toBe("gpt-6-luna");
  const messages = historyMsgs(parsed.turns, "/tmp");
  expect(messages[0]?.role).toBe("user");
  expect(messages[0]?.parts).toEqual([{ type: "text", text: "Read it." }]);
  const parts = messages.flatMap(m => m.parts);
  expect(parts).toContainEqual({ type: "thinking", text: "Checking." });
  expect(parts.find(p => p.type === "tool")).toMatchObject({ name: "bash", input: { command: "cat file" }, output: "contents", status: "done" });
  expect(parts).toContainEqual({ type: "text", text: "Done." });
});

test("a private rollout's failure remains failed when its daemon is gone", () => {
  const raw = [line("event_msg", { type: "task_started", turn_id: "turn" }, 1), line("event_msg", { type: "user_message", message: "Try." }, 2), line("event_msg", { type: "error", message: "API quota exhausted." }, 3)].join("\n");
  const parsed = parsePrivateRollout(raw, "thread", source);
  expect(parsed.turns[0].status).toBe("failed");
  const messages = historyMsgs(parsed.turns, "/tmp");
  expect(messages.at(-1)?.error).toContain("quota exhausted");
});
