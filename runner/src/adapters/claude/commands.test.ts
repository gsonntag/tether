// From real runs on Claude Code 2.1.316 (fixtures/commands*.j*, scratch project).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sink } from "../../core/adapter";
import { Transcript } from "../../core/transcript";
import { claudeCommandRoute, commandList, lastGoalStatus } from "./commands";
import { ClaudeStream } from "./stream";
import { userMessage } from "./content";

const raw = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/commands-list.json"), "utf8"));
const frames = readFileSync(join(import.meta.dir, "fixtures/commands.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
function fakeSink() {
  const t = new Transcript();
  const sink = { event: (e: any) => t.apply(e), message: (id: string) => t.get(id), state() {}, request: async () => ({ allow: true }), subagent: () => sink } as unknown as Sink;
  return { ...sink, event: sink.event, msgs: () => t.messages } as Sink & { msgs(): any[] };
}
const texts = (msgs: any[]) => msgs.filter((m) => m.role === "notice").map((m) => m.parts[0].text);

describe("the list", () => {
  const list = commandList(raw, new Set(["grilling"]), new Set(["code-review"]));
  const names = list.map((c) => c.name);
  test("what Claude Code reports, without internals, config or what it says only suits a terminal", () => {
    expect(names).toContain("compact");
    expect(names).toContain("goal");
    expect(names.some((n) => n.startsWith("__"))).toBe(false);
    expect(names).not.toContain("config");
    expect(names).not.toContain("code-review");
  });
  test("/goal takes a condition, though its non-interactive row has no hint", () => {
    expect(list.find((c) => c.name === "goal")?.args).toBe("[<condition> | clear]");
  });
  test("skills are marked, an argument hint kept", () => {
    expect(list.find((c) => c.name === "grilling")?.skill).toBe(true);
    expect(list.find((c) => c.name === "compact")?.args).toBeTruthy();
  });
});

test("what stays out of the chat's reach", () => {
  for (const n of ["config", "login", "logout", "install", "plugin"]) expect(claudeCommandRoute(n, "")).toEqual({ terminal: true });
  expect(claudeCommandRoute("model", "haiku")).toEqual({ setting: "model", value: "haiku" });
  expect(claudeCommandRoute("compact", "")).toBeUndefined();
});

describe("what commands say", () => {
  const replay = (host: object = {}) => {
    const sink = fakeSink();
    const s = new ClaudeStream(sink, { nativeId: "n", ...host });
    for (const m of frames) s.handle(m);
    return { sink, s };
  };
  test("output, refusals in Tether's words, why Claude goes on, and its limit", () => {
    const said = texts(replay().sink.msgs());
    expect(said.some((t) => t.startsWith("## Context Usage"))).toBe(true);
    expect(said.some((t) => t.startsWith("Goal set:"))).toBe(true);
    expect(said).toContain("/help needs the terminal.");
    expect(said.some((t) => t.startsWith("Not done yet: Only the first assistant message"))).toBe(true);
    expect(said).toContain("Claude Code ended the turn: a Stop hook kept it going too many times.");
    expect(said).toContain("Context compacted.");
  });
  test("a goal met shows from the store, once", async () => {
    const { sink, s } = replay({ goalStatus: async () => ({ uuid: "g1", met: true, reason: "It said mango." }) });
    s.handle({ type: "result", subtype: "success", session_id: "n" });
    await Bun.sleep(5);
    s.handle({ type: "result", subtype: "success", session_id: "n" });
    await Bun.sleep(5);
    expect(texts(sink.msgs()).filter((t) => t === "Goal met: It said mango.")).toHaveLength(1);
  });
  test("the store reads the same", () => {
    expect(userMessage("<goal-met>It said mango.</goal-met>", "g1", 1)?.parts[0]).toEqual({ type: "text", text: "Goal met: It said mango." });
    expect(userMessage("Stop hook feedback:\n[cond]: not yet", "u", 1, { isMeta: true })?.parts[0]).toEqual({ type: "text", text: "Not done yet: not yet" });
  });
});

test("the last evaluation in the store, not its opening sentinel", async () => {
  const f = join(mkdtempSync(join(tmpdir(), "goal-")), "s.jsonl");
  const line = (uuid: string, attachment: object) => JSON.stringify({ type: "attachment", uuid, attachment });
  writeFileSync(f, [line("a", { type: "goal_status", met: false, sentinel: true, condition: "c" }), line("b", { type: "goal_status", met: true, reason: "done", condition: "c" }), line("c", { type: "goal_status", met: false, sentinel: true, condition: "d" })].join("\n") + "\n");
  expect(await lastGoalStatus(f)).toEqual({ uuid: "b", met: true, reason: "done" });
  expect(await lastGoalStatus(undefined)).toBeUndefined();
});
