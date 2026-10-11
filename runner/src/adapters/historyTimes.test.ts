// Replayed histories keep each message's own time (what the harness stored), never the time they
// were loaded; stored sessions list at their last message's time, not their file's mtime.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.TETHER_TEST_ROOT) process.env.TETHER_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tether-times-"));
const { entryMeta, historyMessages } = await import("./claude");
const { historyMsgs } = await import("./codex");
const { convertAll, piMeta } = await import("./pi");
const { transcriptToMessages } = await import("./agy");
const { lastLineTime, claudePick, codexPick, agyPick, TAIL_BUDGET } = await import("./lastActivity");

const T = Date.parse("2026-10-09T15:42:05.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("Claude Code", () => {
  const line = (e: Record<string, unknown>) => JSON.stringify(e);
  const jsonl = [
    line({ parentUuid: null, type: "user", message: { role: "user", content: "hello" }, uuid: "u1", timestamp: iso(T), cwd: "/p" }),
    // a block of the reply, then a second block of the same API message, written later
    line({ parentUuid: "u1", type: "assistant", message: { id: "api1", role: "assistant", content: [{ type: "text", text: "hi" }] }, uuid: "a1", timestamp: iso(T + 2_000) }),
    line({ parentUuid: "a1", type: "assistant", message: { id: "api1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] }, uuid: "a2", timestamp: iso(T + 3_000) }),
    line({ parentUuid: "a2", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }, uuid: "r1", timestamp: iso(T + 9_000), toolUseResult: { uuid: "a1", timestamp: iso(T + 99_000) } }),
    line({ parentUuid: "r1", type: "user", message: { role: "user", content: "next" }, uuid: "u2", timestamp: iso(T + 60_000) }),
    line({ type: "ai-title", aiTitle: "x", sessionId: "s" }),
  ].join("\n");

  test("each entry's time comes from the transcript, a nested look-alike doesn't override it", () => {
    const { times } = entryMeta(jsonl);
    expect(times.get("u1")).toBe(T);
    expect(times.get("a1")).toBe(T + 2_000);
    expect(times.get("u2")).toBe(T + 60_000);
  });

  test("history messages carry those times", () => {
    const list = jsonl
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.uuid)
      .map((e) => ({ type: e.type, uuid: e.uuid, message: e.message, parent_tool_use_id: null }));
    const msgs = historyMessages(list, entryMeta(jsonl));
    expect(msgs.map((m) => [m.role, m.ts])).toEqual([
      ["user", T],
      ["assistant", T + 2_000], // when the reply started
      ["user", T + 60_000],
    ]);
  });

  test("an entry without a recorded time takes the one before it, never now", () => {
    const msgs = historyMessages(
      [
        { type: "user", uuid: "u1", message: { role: "user", content: "a" }, parent_tool_use_id: null },
        { type: "user", uuid: "zz", message: { role: "user", content: "b" }, parent_tool_use_id: null },
      ],
      entryMeta(jsonl),
    );
    expect(msgs.map((m) => m.ts)).toEqual([T, T]);
  });
});

describe("Codex", () => {
  const user = (id: string, text: string) => ({ type: "userMessage", id, content: [{ type: "text", text }] });
  const reply = (id: string, text: string) => ({ type: "agentMessage", id, text });

  test("messages take their turn's start (seconds), or their item's own start when known", () => {
    const turns = [
      { id: "t1", startedAt: T / 1000, completedAt: T / 1000 + 5, items: [user("i1", "one"), reply("i2", "ok")] },
      // a message steered in mid-turn
      { id: "t2", startedAt: T / 1000 + 60, items: [user("i3", "two"), reply("i4", "working"), user("i5", "also"), reply("i6", "done")] },
      // no times at all: the turn before's
      { id: "t3", startedAt: null, completedAt: null, items: [user("i7", "three")] },
    ];
    const times = new Map([
      ["i5", T + 75_000],
      ["i6", T + 76_000],
    ]);
    const msgs = historyMsgs(turns, "/p", "gpt", times);
    expect(msgs.map((m) => [m.id, m.ts])).toEqual([
      ["u-i1", T],
      ["a-i2", T],
      ["u-i3", T + 60_000],
      ["a-i4", T + 60_000],
      ["u-i5", T + 75_000],
      ["a-i6", T + 76_000],
      ["u-i7", T + 60_000],
    ]);
  });
});

describe("pi", () => {
  test("messages keep pi's own timestamps; one without takes the message before's", () => {
    const msgs = convertAll([
      { role: "user", content: "hi", timestamp: T },
      { role: "assistant", content: [{ type: "text", text: "yo" }], timestamp: T + 1_000 },
      { role: "user", content: "again" },
      { role: "user", content: "iso", timestamp: iso(T + 5_000) },
    ]);
    expect(msgs.map((m) => m.ts)).toEqual([T, T + 1_000, T + 1_000, T + 5_000]);
  });

  test("a session file's title and last message time (not its model changes)", () => {
    const row = (type: string, ts: number, extra: Record<string, unknown>) => JSON.stringify({ type, id: "x" + ts, parentId: null, timestamp: iso(ts), ...extra });
    const text = [
      JSON.stringify({ type: "session", version: 3, id: "s", timestamp: iso(T), cwd: "/p" }),
      row("message", T + 1_000, { message: { role: "user", content: [{ type: "text", text: "Fix the build" }], timestamp: T + 1_000 } }),
      row("message", T + 9_000, { message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: T + 2_000 } }),
      row("model_change", T + 60_000, { provider: "x", modelId: "y" }),
    ].join("\n");
    expect(piMeta(text)).toEqual({ title: "Fix the build", lastAt: T + 9_000 });
  });
});

describe("Antigravity", () => {
  test("steps keep their created_at; one without takes the step before's", () => {
    const { messages } = transcriptToMessages([
      { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", created_at: iso(T), content: "<USER_REQUEST>\nhi\n</USER_REQUEST>" },
      { step_index: 1, type: "PLANNER_RESPONSE", content: "hello" },
    ]);
    expect(messages.map((m) => [m.role, m.ts])).toEqual([
      ["user", T],
      ["assistant", T],
    ]);
  });
});

describe("lastLineTime", () => {
  const dir = mkdtempSync(join(tmpdir(), "tether-last-"));

  test("finds the last message line, reading further back past a long non-message tail", async () => {
    const f = join(dir, "claude.jsonl");
    const noise = Array.from({ length: 3000 }, () => JSON.stringify({ type: "queue-operation", operation: "x".repeat(40), timestamp: iso(T + 999_000) })).join("\n");
    writeFileSync(f, [JSON.stringify({ type: "user", uuid: "u", timestamp: iso(T) }), JSON.stringify({ type: "assistant", uuid: "a", timestamp: iso(T + 5_000) }), noise, ""].join("\n"));
    expect(await lastLineTime(f, claudePick)).toBe(T + 5_000);
  });

  test("ignores a subagent's entries, and caches by mtime and size", async () => {
    const f = join(dir, "side.jsonl");
    writeFileSync(f, [JSON.stringify({ type: "user", timestamp: iso(T) }), JSON.stringify({ type: "assistant", isSidechain: true, timestamp: iso(T + 1) })].join("\n"));
    expect(await lastLineTime(f, claudePick)).toBe(T);
    writeFileSync(f, JSON.stringify({ type: "user", timestamp: iso(T + 7) }) + "\n");
    utimesSync(f, new Date(T), new Date(T + 1_000_000));
    expect(await lastLineTime(f, claudePick)).toBe(T + 7);
  });

  test("Claude Code's own meta entries (command caveats, skill bodies) aren't messages", async () => {
    const f = join(dir, "meta.jsonl");
    writeFileSync(f, [JSON.stringify({ type: "assistant", timestamp: iso(T) }), JSON.stringify({ type: "user", isMeta: true, timestamp: iso(T + 9_000) }), ""].join("\n"));
    expect(await lastLineTime(f, claudePick)).toBe(T);
  });

  test("reads at most TAIL_BUDGET from the end; a message line split across chunks is whole", async () => {
    // A message line straddling the first chunk boundary, behind a long tail of non-message lines.
    const f = join(dir, "straddle.jsonl");
    const big = JSON.stringify({ type: "assistant", timestamp: iso(T + 1), message: { content: "é".repeat(50_000) } });
    const tail = Array.from({ length: 400 }, () => JSON.stringify({ type: "progress", data: "y".repeat(100) })).join("\n");
    writeFileSync(f, [JSON.stringify({ type: "user", timestamp: iso(T) }), big, tail, ""].join("\n"));
    expect(await lastLineTime(f, claudePick)).toBe(T + 1);
    // the only message is further back than the budget: undefined (the caller falls back to the mtime)
    const g = join(dir, "far.jsonl");
    const noise = JSON.stringify({ type: "progress", data: "z".repeat(1000) });
    writeFileSync(g, [JSON.stringify({ type: "user", timestamp: iso(T) }), ...Array.from({ length: Math.ceil(TAIL_BUDGET / 1000) + 10 }, () => noise), ""].join("\n"));
    expect(await lastLineTime(g, claudePick)).toBeUndefined();
  });

  test("the first line of a file read whole counts", async () => {
    const f = join(dir, "one.jsonl");
    writeFileSync(f, JSON.stringify({ type: "user", timestamp: iso(T + 3) }));
    expect(await lastLineTime(f, claudePick)).toBe(T + 3);
  });

  test("Codex rollout and Antigravity transcript lines; none found or no file: undefined", async () => {
    const c = join(dir, "rollout.jsonl");
    writeFileSync(
      c,
      [
        JSON.stringify({ timestamp: iso(T), type: "response_item", payload: { type: "message" } }),
        JSON.stringify({ timestamp: iso(T + 50_000), type: "event_msg", payload: { type: "thread_settings_applied" } }),
      ].join("\n"),
    );
    expect(await lastLineTime(c, codexPick)).toBe(T);
    const a = join(dir, "transcript_full.jsonl");
    writeFileSync(a, JSON.stringify({ step_index: 3, created_at: iso(T + 3_000) }) + "\n");
    expect(await lastLineTime(a, agyPick)).toBe(T + 3_000);
    const n = join(dir, "none.jsonl");
    writeFileSync(n, JSON.stringify({ type: "ai-title" }));
    expect(await lastLineTime(n, claudePick)).toBeUndefined();
    expect(await lastLineTime(join(dir, "missing.jsonl"), claudePick)).toBeUndefined();
  });
});
