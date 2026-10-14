// Reading opencode's SQLite store without starting `opencode acp` (shapes as stored by opencode 1.x).

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeHistory, readOpencodeSession } from "./opencodeDb";

const SID = "ses_test1";

function makeDb(opts: { schema?: "ok" | "old" } = {}): string {
  const path = join(mkdtempSync(join(tmpdir(), "oc-db-")), "opencode.db");
  const db = new Database(path);
  db.run("create table session (id text primary key, directory text not null, title text not null, time_created integer not null, time_updated integer not null)");
  if (opts.schema === "old") db.run("create table message (id text primary key, session_id text not null, info text not null)");
  else db.run("create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null)");
  db.run("create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null)");
  db.run("insert into session values (?, '/tmp/p', 'Edit README', 1, 2)", [SID]);
  if (opts.schema === "old") return (db.close(), path);
  const msg = (id: string, t: number, data: object) => db.run("insert into message values (?, ?, ?, ?, ?)", [id, SID, t, t, JSON.stringify(data)]);
  const part = (id: string, mid: string, data: object) => db.run("insert into part values (?, ?, ?, 0, 0, ?)", [id, mid, SID, JSON.stringify(data)]);
  msg("msg_1", 1000, { role: "user", time: { created: 1000 }, agent: "build", model: { providerID: "opencode", modelID: "big-pickle" } });
  part("prt_1a", "msg_1", { type: "text", text: "Edit the README please" });
  part("prt_1b", "msg_1", { type: "text", text: "<file contents>", synthetic: true });
  part("prt_1c", "msg_1", { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,iVBORw0K" });
  msg("msg_2", 2000, {
    role: "assistant",
    time: { created: 2000, completed: 2500 },
    modelID: "big-pickle",
    providerID: "opencode",
    mode: "plan",
    agent: "plan",
    tokens: { total: 13046, input: 64, output: 42, reasoning: 12, cache: { write: 0, read: 12928 } },
  });
  part("prt_2a", "msg_2", { type: "step-start" });
  part("prt_2b", "msg_2", { type: "reasoning", text: "Read it first." });
  part("prt_2c", "msg_2", { type: "tool", tool: "bash", callID: "call_bash", state: { status: "completed", input: { command: "ls" }, output: "README.md\n", title: "ls" } });
  part("prt_2d", "msg_2", { type: "tool", tool: "edit", callID: "call_edit", state: { status: "completed", input: { filePath: "/tmp/p/README.md", oldString: "hello", newString: "hello world" }, output: "Edit applied successfully." } });
  part("prt_2e", "msg_2", { type: "tool", tool: "write", callID: "call_write", state: { status: "error", input: { filePath: "/tmp/p/x", content: "x" }, error: "denied" } });
  part("prt_2f", "msg_2", { type: "tool", tool: "todowrite", callID: "call_todo", state: { status: "completed", input: { todos: [{ content: "Edit", status: "completed" }, { content: "Test", status: "in_progress" }] }, output: "[]" } });
  part("prt_2g", "msg_2", { type: "tool", tool: "bash", callID: "call_cut", state: { status: "running", input: { command: "sleep 100" } } });
  part("prt_2h", "msg_2", { type: "text", text: "Done." });
  part("prt_2i", "msg_2", { type: "step-finish", reason: "stop" });
  msg("msg_3", 3000, { role: "assistant", time: { created: 3000 }, modelID: "big-pickle", providerID: "opencode", error: { name: "MessageAbortedError", data: { message: "Aborted" } } });
  db.close();
  return path;
}

describe("opencode's database", () => {
  test("a session reads as the transcript the ACP replay shows", () => {
    const path = makeDb();
    const before = statSync(path).mtimeMs;
    const h = readOpencodeSession(SID, path)!;
    expect(statSync(path).mtimeMs).toBe(before); // read-only
    expect(h.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    const [user, reply, aborted] = h.messages;
    // what you typed, not opencode's synthetic parts; images as images
    expect(user!.parts).toEqual([
      { type: "text", text: "Edit the README please" },
      { type: "image", mimeType: "image/png", data: "iVBORw0K" },
    ]);
    expect(user!.ts).toBe(1000);
    expect(reply!.model).toBe("opencode/big-pickle");
    const kinds = reply!.parts.map((p) => (p.type === "tool" ? `tool:${p.name}:${p.status}` : p.type));
    expect(kinds).toEqual(["thinking", "tool:bash:done", "tool:edit:done", "tool:write:error", "tool:todowrite:done", "plan", "tool:bash:error", "text"]);
    const edit = reply!.parts.find((p) => p.type === "tool" && p.name === "edit") as any;
    expect(edit.input).toEqual({ path: "/tmp/p/README.md", edits: [{ oldText: "hello", newText: "hello world" }] });
    expect((reply!.parts.find((p) => p.type === "tool" && p.name === "write") as any).output).toBe("denied");
    expect((reply!.parts.find((p) => p.type === "plan") as any).text).toContain("- [x] Edit");
    expect(aborted!.error).toBe("aborted");
    expect(h.context).toMatchObject({ used: 13046, cacheRead: 12928, model: "opencode/big-pickle" });
    expect(h.model).toBe("opencode/big-pickle");
    expect(h.permissionMode).toBe("plan");
  });

  test("anything unexpected reads as undefined (the agent replays it instead)", () => {
    expect(readOpencodeSession(SID, join(tmpdir(), "no-such-dir-oc", "opencode.db"))).toBeUndefined();
    expect(readOpencodeSession("ses_other", makeDb())).toBeUndefined();
    expect(readOpencodeSession(SID, makeDb({ schema: "old" }))).toBeUndefined();
    const junk = join(mkdtempSync(join(tmpdir(), "oc-db-")), "opencode.db");
    writeFileSync(junk, "not a database");
    expect(readOpencodeSession(SID, junk)).toBeUndefined();
  });

  test("rows without parts or with bad data are skipped", () => {
    const h = opencodeHistory([
      { id: "m1", time: 5, info: { role: "user" }, parts: [] },
      { id: "m2", time: 6, info: { role: "assistant" }, parts: [{ type: "step-start" }] },
      { id: "m3", time: 7, info: {}, parts: [{ type: "text", text: "?" }] },
    ]);
    expect(h.messages).toEqual([]);
    expect(h.context).toBeUndefined();
  });
});
