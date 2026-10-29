import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readHistory } from "./history";
import { canonicalCommand } from "./content";
import { ClaudeStream } from "./stream";
import { Transcript } from "../../core/transcript";

// Recorded sessions, stored as Claude Code wrote them (fixtures/store is a CLAUDE_CONFIG_DIR).
const DIR = "/home/ubuntu/.local/share/tether-dev/projects/scratch";
beforeAll(() => (process.env.CLAUDE_CONFIG_DIR = join(import.meta.dir, "fixtures", "store")));

const REPLY = "abbefbf3-72fa-4be1-9f18-7caab9dcb09b";
const SUB = "0baf46c3-634f-4340-bced-ec08230ff082";
const INTERRUPT = "5a8f3ee4-822a-495e-97e2-732d675538ac";

function live(fixture: string) {
  const t = new Transcript();
  const children: string[] = [];
  const sink: any = { event: (e: any) => t.apply(e), message: (id: string) => t.get(id), state() {}, request: async () => ({ allow: true }), subagent: (s: any) => (children.push(s.nativeId), { ...sink, event() {}, ended() {} }) };
  const s = new ClaudeStream(sink, { nativeId: fixture === "subagent.jsonl" ? SUB : "x" });
  for (const l of readFileSync(join(import.meta.dir, "fixtures", fixture), "utf8").split("\n").filter(Boolean)) s.handle(JSON.parse(l));
  return { msgs: t.messages, children };
}

test("a stored session reads as the live stream showed it: same ids, same parts", async () => {
  const stored = await readHistory(REPLY, DIR);
  expect(stored[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: expect.stringContaining("number 7") }] });
  expect(stored[0]!.ts).toBeGreaterThan(1_700_000_000_000);
  const { msgs } = live("reply.jsonl");
  // The live stream has no prompt (the driver adds it), otherwise the same messages.
  expect(stored.slice(1).map((m) => m.id)).toEqual(msgs.map((m) => m.id));
  const tool = (ms: readonly any[]) => ms.flatMap((m) => m.parts).find((p: any) => p.type === "tool");
  const { input: _a, ...st } = tool(stored);
  const { input: _b, ...lt } = tool(msgs);
  expect(st).toEqual(lt);
  // Thinking is stored empty; the text is the same.
  const text = (ms: readonly any[]) => ms.flatMap((m) => m.parts).filter((p: any) => p.type === "text").map((p: any) => p.text);
  expect(text(stored.slice(1))).toEqual(text(msgs));
});

test("an interrupted session shows the Interrupted notice in both", async () => {
  const stored = await readHistory(INTERRUPT, DIR);
  expect(stored.at(-1)).toMatchObject({ role: "notice", parts: [{ text: "Interrupted" }] });
  expect(live("interrupt.jsonl").msgs.at(-1)!.id).toBe(stored.at(-1)!.id);
});

test("a stored session links its Agent call to the subagent, whose own transcript reads too", async () => {
  const stored = await readHistory(SUB, DIR);
  const call = stored.flatMap((m) => m.parts).find((p) => p.type === "tool" && p.name === "Agent") as any;
  expect(call.childSessionId).toMatch(new RegExp(`^claude:${SUB}/[0-9a-f]+$`));
  // The task notification Claude got isn't shown (the live stream doesn't show it either).
  expect(stored.some((m) => m.role === "notice")).toBe(false);
  expect(stored.map((m) => m.id).filter((x) => x.startsWith("msg_"))).toEqual(live("subagent.jsonl").msgs.map((m) => m.id));
  const child = await readHistory(call.childSessionId.slice("claude:".length), DIR);
  expect(child[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: expect.stringContaining("wc -l") }] });
  const bash = child.flatMap((m) => m.parts).find((p) => p.type === "tool") as any;
  expect(bash).toMatchObject({ name: "Bash", status: "done" });
  expect(bash.output).toContain("total");
  // The live child id is the same native id.
  expect(live("subagent.jsonl").children[0]!.split("/")[0]).toBe(SUB);
});

test("slash commands read as the live view showed them: output as notices, /compact before its notice", async () => {
  // A real session: /context, a prompt, /compact, a prompt (scripts/parity-claude.ts checked live = stored).
  const msgs = await readHistory("a8d21b1b-b9ed-4f99-a554-acb8bf137c86", DIR);
  const rows = msgs.map((m) => `${m.role}:${((m.parts[0] as any)?.text ?? "").split("\n")[0]}`);
  expect(rows).toEqual(["user:/context", "notice:## Context Usage", "user:Say ok.", "assistant:", "user:/compact", "notice:Context compacted.", "user:Say done.", "assistant:Done."]);
});

test("a command Claude Code stores under another name reads that way live too", () => {
  expect(canonicalCommand("/cost")).toBe("/usage");
  expect(canonicalCommand("/cost now")).toBe("/usage now");
  expect(canonicalCommand("/costly")).toBe("/costly");
  expect(canonicalCommand("tell me the /cost")).toBe("tell me the /cost");
});
