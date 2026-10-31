import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { readHistory } from "./history";
import { claudeProjects, claudeSessionInfo, claudeSessions, claudeSubagents, titleOf } from "./discovery";

const DIR = "/home/ubuntu/.local/share/tether-dev/projects/scratch";
const SUB = "0baf46c3-634f-4340-bced-ec08230ff082";
beforeAll(() => (process.env.CLAUDE_CONFIG_DIR = join(import.meta.dir, "fixtures", "store")));

test("sessions are listed with titles and the time of their last message", async () => {
  const list = await claudeSessions();
  expect(list.map((s) => s.id).sort()).toEqual(["claude:0baf46c3-634f-4340-bced-ec08230ff082", "claude:5a8f3ee4-822a-495e-97e2-732d675538ac", "claude:9a7a11e1-0000-4000-8000-000000000001", "claude:a8d21b1b-b9ed-4f99-a554-acb8bf137c86", "claude:abbefbf3-72fa-4be1-9f18-7caab9dcb09b"]);
  const sub = list.find((s) => s.nativeId === SUB)!;
  expect(sub).toMatchObject({ harness: "claude", projectPath: DIR, title: "Line count for README.md and math.ts", mode: "stored", status: "idle" });
  // The last message's time (2026-10-29), not the copy's mtime.
  expect(new Date(sub.updatedAt).toISOString().slice(0, 10)).toBe("2026-10-29");
  expect(await claudeSessions({ since: Date.now() + 1000 })).toEqual([]);
  expect((await claudeSessions({ projectPath: DIR })).length).toBe(5);
});

test("projects, subagents and single rows", async () => {
  const projects = await claudeProjects();
  expect(projects.find((p) => p.path === DIR)).toMatchObject({ name: "scratch", sessions: 5, harnesses: ["claude"] });
  const kids = claudeSubagents(SUB, DIR);
  // The subagent, and a workflow's agent (subagents/workflows/<run>/), openable like any.
  expect(kids).toHaveLength(2);
  const wf = kids.find((k) => k.nativeId.includes("/wf_"))!;
  expect(wf).toMatchObject({ nativeId: `${SUB}/wf_0000test-001/a0000000000000001`, title: "find:line-counts", agentType: "workflow-subagent", parentSessionId: `claude:${SUB}` });
  expect(await claudeSessionInfo(wf.nativeId, DIR)).toEqual(wf);
  const wfMsgs = await readHistory(wf.nativeId, DIR);
  expect(wfMsgs.flatMap((m) => m.parts).find((p) => p.type === "tool")).toMatchObject({ name: "Bash", status: "done" });
  kids.splice(kids.indexOf(wf), 1);
  expect(kids[0]).toMatchObject({ parentSessionId: `claude:${SUB}`, agentType: "general-purpose", mode: "stored" });
  expect(kids[0]!.parentToolId).toMatch(/^toolu_/);
  expect(await claudeSessionInfo(kids[0]!.nativeId, DIR)).toEqual(kids[0]);
  expect((await claudeSessionInfo(SUB))?.title).toBe("Line count for README.md and math.ts");
  expect(await claudeSessionInfo("00000000-0000-0000-0000-000000000000")).toBeUndefined();
});

test("titles: yours, then Claude's, then the first prompt", () => {
  expect(titleOf({ customTitle: "Mine", summary: "Claude's", firstPrompt: "x" })).toBe("Mine");
  expect(titleOf({ summary: "Claude's\nsummary", firstPrompt: "x" } as any)).toBe("Claude's summary");
  // A slash command isn't a title.
  expect(titleOf({ firstPrompt: "<command-name>/compact</command-name><command-args>now</command-args>" } as any)).toBe("Untitled");
  expect(titleOf({ firstPrompt: "<command-name>/clear</command-name>" } as any)).toBe("Untitled");
  expect(titleOf({ firstPrompt: "/clear", summary: "Fresh start" } as any)).toBe("Fresh start");
  expect(titleOf({} as any)).toBe("Untitled");
  // The SDK's summary falls back to the prompts: that isn't a title of Claude's.
  expect(titleOf({ firstPrompt: "/exit", summary: "/exit" } as any)).toBe("Untitled");
  expect(titleOf({ firstPrompt: "Say hi", summary: "Say hi" } as any)).toBe("Say hi");
  expect(titleOf({ firstPrompt: "/clear", summary: "/exit" } as any)).toBe("Untitled");
});

test("a store with only local commands never started; one with a prompt or an answer did", async () => {
  const { onlyLocalCommands } = await import("./discovery");
  const user = (text: string) => ({ id: text, role: "user" as const, ts: 1, parts: [{ type: "text" as const, text }] });
  expect(onlyLocalCommands([])).toBe(true);
  expect(onlyLocalCommands([user("/clear"), { id: "n", role: "notice", ts: 2, parts: [{ type: "text", text: "Kept model" }] }])).toBe(true);
  expect(onlyLocalCommands([user("/model"), user("Say hi.")])).toBe(false);
  expect(onlyLocalCommands([user("/review"), { id: "a", role: "assistant", ts: 2, parts: [{ type: "text", text: "ok" }] }])).toBe(false);
});

test("the store's permission-mode entries: how many, and the last", async () => {
  const { storedModeIn } = await import("./discovery");
  const line = (m: string) => JSON.stringify({ type: "permission-mode", permissionMode: m, sessionId: "x" });
  expect(storedModeIn("")).toEqual({ mode: undefined, entries: 0 });
  expect(storedModeIn([line("default"), '{"type":"user","text":"\\"permission-mode\\""}', "{half", line("acceptEdits")].join("\n"))).toEqual({ mode: "acceptEdits", entries: 2 });
});
