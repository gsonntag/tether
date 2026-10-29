import { beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transcript } from "../../core/transcript";
import { chainMessages, readHistory } from "./history";
import { cachedStores, pinStore, readStore, StoreFile } from "./jsonl";

// An anonymized copy of a real session compacted twice (scripts/anonymize-claude.ts): its
// structure, ids and timestamps as Claude Code wrote them, its text replaced.
const STORE = join(import.meta.dir, "fixtures", "store");
const FILE = join(STORE, "projects", "-compacted", "c0mpac7e-0000-4000-8000-000000000001.jsonl");
beforeAll(() => (process.env.CLAUDE_CONFIG_DIR = STORE));

test("a compacted session shows every segment, oldest first, with a notice at each compaction", async () => {
  const msgs = await readHistory("c0mpac7e-0000-4000-8000-000000000001", "/compacted");
  // The SDK's walk stopped at the last compaction: 4 prompts. The whole conversation has 247
  // (one of them queued mid-turn, on a branch beside the conversation).
  expect(msgs.filter((m) => m.role === "user").length).toBe(247);
  const notices = msgs.map((m, i) => [i, m] as const).filter(([, m]) => m.role === "notice" && (m.parts[0] as any).text === "Context compacted.");
  expect(notices).toHaveLength(2);
  // Conversation before the first, between, and after the second.
  const [a, b] = [notices[0]![0], notices[1]![0]];
  expect(a).toBeGreaterThan(100);
  expect(b - a).toBeGreaterThan(100);
  expect(msgs.length - b).toBeGreaterThan(5);
  // In time order, no message twice.
  expect(new Set(msgs.map((m) => m.id)).size).toBe(msgs.length);
  // Segments in time order (single messages can be out by a little: queued prompts).
  expect(msgs[0]!.ts).toBeLessThan(msgs[a]!.ts);
  expect(msgs[a]!.ts).toBeLessThan(msgs[b]!.ts);
  expect(msgs[b]!.ts).toBeLessThanOrEqual(msgs.at(-1)!.ts);
  // The summary Claude continues from isn't shown as a message of yours.
  expect(msgs.some((m) => m.role === "user" && (m.parts[0] as any)?.text === "summary")).toBe(false);
});

test("paging walks back across compactions to the first message", async () => {
  const msgs = await readHistory("c0mpac7e-0000-4000-8000-000000000001", "/compacted");
  const t = new Transcript(msgs);
  let page = t.newest(50);
  const seen = [...page.messages];
  while (page.hasOlder) {
    page = t.before(seen[0]!.id, 50);
    seen.unshift(...page.messages);
  }
  expect(seen.map((m) => m.id)).toEqual(msgs.map((m) => m.id));
});

test("a growing file is read incrementally and matches a full read; a rewrite is read again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tether-jsonl-"));
  const path = join(dir, "s.jsonl");
  const lines = readFileSync(FILE, "utf8").split("\n").filter(Boolean);
  writeFileSync(path, lines.slice(0, 3000).join("\n") + "\n" + lines[3000]!.slice(0, 50)); // a half-written line
  const f = new StoreFile(path);
  await f.update();
  const partial = chainMessages(f.chain()).length;
  const offset = f.offset;
  writeFileSync(path, lines.slice(0, 3000).join("\n") + "\n");
  appendFileSync(path, lines.slice(3000).join("\n") + "\n");
  expect(await f.update()).toBe(true);
  expect(f.offset).toBeGreaterThan(offset);
  const full = new StoreFile(FILE);
  await full.update();
  expect(chainMessages(f.chain())).toEqual(chainMessages(full.chain()));
  expect(chainMessages(f.chain()).length).toBeGreaterThan(partial);
  expect(await f.update()).toBe(false);
  // Replaced by a shorter file (a rewrite): read again from the start.
  const other = join(dir, "t.jsonl");
  copyFileSync(join(STORE, "projects", "-home-ubuntu--local-share-tether-dev-projects-scratch", "abbefbf3-72fa-4be1-9f18-7caab9dcb09b.jsonl"), other);
  renameSync(other, path);
  await f.update();
  expect(chainMessages(f.chain()).filter((m) => m.role === "user").length).toBe(1);
});

/** A tiny session file from [uuid, parent, type, text] rows (in the order they were written). */
function file(rows: [string, string | null, "user" | "assistant", string | { tool_result: true } | { image: true }, string?][]) {
  const dir = mkdtempSync(join(tmpdir(), "tether-branch-"));
  const path = join(dir, "b.jsonl");
  writeFileSync(
    path,
    rows
      .map(([uuid, parentUuid, type, text, origin], i) =>
        JSON.stringify({
          uuid,
          ...(origin === "meta" ? { isMeta: true } : origin ? { origin: { kind: origin } } : {}),
          parentUuid,
          type,
          timestamp: new Date(1_800_000_000_000 + i * 1000).toISOString(),
          message:
            type === "assistant"
              ? { id: `msg_${uuid}`, role: "assistant", content: [{ type: "text", text }] }
              : { role: "user", content: typeof text === "string" ? text : "image" in text ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] : [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
        }),
      )
      .join("\n") + "\n",
  );
  return path;
}

const texts = async (path: string) => {
  const f = new StoreFile(path);
  await f.update();
  return chainMessages(f.chain()).map((m) => (m.parts[0] as any)?.text ?? m.role);
};

test("a prompt queued while a turn ran is kept with its reply, in the order written", async () => {
  // u1 -> a1 (tool call) ; the queued prompt q hangs off a1 while the tool runs ; the turn goes on.
  const path = file([
    ["u1", null, "user", "first"],
    ["a1", "u1", "assistant", "running a tool"],
    ["q", "a1", "user", "queued question"],
    ["qa", "q", "assistant", "answer to the queued question"],
    ["r1", "a1", "user", { tool_result: true }],
    ["a2", "r1", "assistant", "done"],
  ]);
  expect(await texts(path)).toEqual(["first", "running a tool", "queued question", "answer to the queued question", "done"]);
});

test("an edited, retried or rewound prompt is not shown; the newer one is", async () => {
  const path = file([
    ["u1", null, "user", "first"],
    ["a1", "u1", "assistant", "reply"],
    ["old", "a1", "user", "old wording"],
    ["olda", "old", "assistant", "old answer"],
    ["new", "a1", "user", "new wording"],
    ["newa", "new", "assistant", "new answer"],
  ]);
  expect(await texts(path)).toEqual(["first", "reply", "new wording", "new answer"]);
});

test("a branch starting at an injected turn (a task notification beside a subagent's report) is kept", async () => {
  const path = file([
    ["u1", null, "user", "first"],
    ["a1", "u1", "assistant", "reply"],
    ["tn", "a1", "user", "<task-notification>x", "task-notification"],
    ["peer", "a1", "user", "Another Claude session sent a message", "peer"],
    ["q", "tn", "user", "a question asked meanwhile"],
    ["qa", "q", "assistant", "its answer"],
    ["pa", "peer", "assistant", "about the report"],
  ]);
  const t = await texts(path);
  expect(t).toContain("a question asked meanwhile");
  expect(t).toContain("its answer");
  expect(t.at(-1)).toBe("about the report");
  // The report is marked as not yours.
  const f = new StoreFile(path);
  await f.update();
  expect(chainMessages(f.chain()).find((m) => m.id === "peer")).toMatchObject({ role: "user", origin: { kind: "peer" } });
});

// Current Claude Code (and Tether's driver) mark every typed prompt origin {kind: "human"}.
describe("prompts marked human (current Claude Code)", () => {
  const H = "human";
  test("an edit hides the old prompt and its answer", async () => {
    const path = file([["u1", null, "user", "first", H], ["a1", "u1", "assistant", "reply"], ["old", "a1", "user", "old wording", H], ["olda", "old", "assistant", "old answer"], ["new", "a1", "user", "new wording", H], ["newa", "new", "assistant", "new answer"]]);
    expect(await texts(path)).toEqual(["first", "reply", "new wording", "new answer"]);
  });
  test("a retry (the same prompt again) shows it once", async () => {
    const path = file([["u1", null, "user", "first", H], ["a1", "u1", "assistant", "reply"], ["q1", "a1", "user", "how far?", H], ["q2", "a1", "user", "how far?", H], ["qa", "q2", "assistant", "this far"]]);
    expect(await texts(path)).toEqual(["first", "reply", "how far?", "this far"]);
  });
  test("a rewind whose new turn starts with a slash command's caveat still hides the old branch", async () => {
    const path = file([["u1", null, "user", "first", H], ["a1", "u1", "assistant", "reply"], ["old", "a1", "user", "abandoned", H], ["olda", "old", "assistant", "abandoned answer"], ["cav", "a1", "user", "<local-command-caveat>x", "meta"], ["cmd", "cav", "user", "<command-name>/model</command-name>", H], ["after", "cmd", "user", "carry on", H], ["aa", "after", "assistant", "carrying on"]]);
    const t = await texts(path);
    expect(t).not.toContain("abandoned");
    expect(t.at(-1)).toBe("carrying on");
  });
  test("an image-only prompt replacing a text one hides the old one", async () => {
    const path = file([["u1", null, "user", "first", H], ["a1", "u1", "assistant", "reply"], ["old", "a1", "user", "describe this", H], ["img", "a1", "user", { image: true }, H], ["ia", "img", "assistant", "a picture"]]);
    expect(await texts(path)).not.toContain("describe this");
  });
  test("a prompt queued mid-turn is still kept", async () => {
    const path = file([["u1", null, "user", "first", H], ["a1", "u1", "assistant", "running a tool"], ["q", "a1", "user", "queued question", H], ["qa", "q", "assistant", "queued answer"], ["r1", "a1", "user", { tool_result: true }], ["a2", "r1", "assistant", "done"]]);
    expect(await texts(path)).toEqual(["first", "running a tool", "queued question", "queued answer", "done"]);
  });
});

test("Claude Code's own replies and malformed lines", () => {
  const e = (over: any, order: number) => ({ parentUuid: null, order, timestamp: "2026-10-29T00:00:00Z", ...over });
  const msgs = chainMessages([
    e({ uuid: "u1", type: "user", message: { role: "user", content: "hi" } }, 1),
    e({ uuid: "s1", type: "assistant", message: { id: "x1", model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "No response requested." }] } }, 2),
    e({ uuid: "s2", type: "assistant", message: { id: "x2", model: "<synthetic>", role: "assistant", apiError: "rate_limit", content: [{ type: "text", text: "You've hit your limit" }] } }, 3),
    // Malformed: text that isn't a string, a tool call without a name.
    e({ uuid: "bad", type: "assistant", message: { id: "x3", role: "assistant", content: [{ type: "text", text: 42 }, { type: "tool_use", id: "t", name: null, input: {} }] } }, 4),
    e({ uuid: "u2", type: "user", message: { role: "user", content: [{ type: "text", text: { nope: 1 } }, { type: "text", text: "still here" }] } }, 5),
  ] as any);
  expect(msgs.find((m) => m.id === "s1")).toMatchObject({ role: "notice", parts: [{ text: "No response requested." }] });
  expect(msgs.find((m) => m.id === "x2")).toMatchObject({ role: "assistant", error: "You've hit your limit" });
  expect(msgs.find((m) => m.id === "x3")!.parts).toMatchObject([{ type: "text", text: "" }, { type: "tool", name: "tool", kind: "other" }]);
  expect(msgs.at(-1)).toMatchObject({ role: "user", parts: [{ type: "text", text: "still here" }] });
});

test("a slash command's output written last is still part of the conversation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tether-cmd-"));
  const p = join(dir, "c.jsonl");
  const t = "2026-10-29T00:00:00Z";
  writeFileSync(
    p,
    [
      { uuid: "u1", parentUuid: null, type: "user", timestamp: t, origin: { kind: "human" }, message: { role: "user", content: "<command-name>/context</command-name>" } },
      { uuid: "o1", parentUuid: "u1", type: "system", subtype: "local_command", timestamp: t, content: "<local-command-stdout>## Context Usage</local-command-stdout>" },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const f = new StoreFile(p);
  await f.update();
  expect(chainMessages(f.chain()).map((m) => `${m.role}:${(m.parts[0] as any).text}`)).toEqual(["user:/context", "notice:## Context Usage"]);
});

test("a local command typed in Claude's own TUI (stored as a system entry) reads as typed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tether-cmd-"));
  const p = join(dir, "c.jsonl");
  const t = "2026-10-29T00:00:00Z";
  // As Claude Code 2.1.312's TUI wrote /model.
  writeFileSync(
    p,
    [
      { uuid: "u1", parentUuid: null, type: "user", timestamp: t, origin: { kind: "human" }, message: { role: "user", content: "hi" } },
      { uuid: "c1", parentUuid: "u1", type: "system", subtype: "local_command", timestamp: t, content: "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>" },
      { uuid: "o1", parentUuid: "c1", type: "system", subtype: "local_command", timestamp: t, content: "<local-command-stdout>Kept model as `Haiku 5.5`</local-command-stdout>" },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const f = new StoreFile(p);
  await f.update();
  expect(chainMessages(f.chain()).map((m) => `${m.role}:${(m.parts[0] as any).text}`)).toEqual(["user:hi", "user:/model", "notice:Kept model as `Haiku 5.5`"]);
});

describe("parallel tool calls", () => {
  // Real Claude (Haiku): one call, then two in parallel. Claude Code writes each parallel call as
  // its own assistant entry in a chain, and each result is parented to its own call, so the first
  // result ("two") hangs beside the chain.
  const PARALLEL = join(STORE, "projects", "-home-ubuntu--local-share-tether-dev-projects-scratch", "9a7a11e1-0000-4000-8000-000000000001.jsonl");
  const bash = (msgs: any[]) => msgs.flatMap((m) => m.parts).filter((p: any) => p.type === "tool").map((p: any) => `${p.status}:${p.output}`);

  test("every call gets its result, wherever the result hangs", async () => {
    const msgs = await readHistory("9a7a11e1-0000-4000-8000-000000000001", "/home/ubuntu/.local/share/tether-dev/projects/scratch");
    expect(bash(msgs)).toEqual(["done:one", "done:two", "done:three"]);
    expect((msgs.at(-1)!.parts[0] as any).text).toBe("done");
  });

  test("the same in a subagent's own file (every entry a sidechain)", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "tether-sub-")), "subagents");
    mkdirSync(dir);
    const path = join(dir, "agent-a1.jsonl");
    writeFileSync(path, readFileSync(PARALLEL, "utf8").split("\n").filter(Boolean).map((l) => JSON.stringify({ ...JSON.parse(l), isSidechain: true })).join("\n") + "\n");
    const f = new StoreFile(path);
    await f.update();
    expect(bash(chainMessages(f.chain()))).toEqual(["done:one", "done:two", "done:three"]);
  });
});

test("a prompt delivered mid-turn (a queued_command attachment) shows where it reached Claude", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tether-queued-"));
  const path = join(dir, "q.jsonl");
  const at = (i: number) => new Date(1_800_000_000_000 + i * 1000).toISOString();
  const rows = [
    { uuid: "u1", parentUuid: null, type: "user", timestamp: at(0), message: { role: "user", content: "first" } },
    { uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: at(1), message: { id: "msg_a1", role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } }] } },
    { uuid: "r1", parentUuid: "a1", type: "user", timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } },
    { uuid: "q1", parentUuid: "r1", type: "attachment", timestamp: at(3), attachment: { type: "queued_command", prompt: "also this", source_uuid: "src1", origin: { kind: "human" } } },
    { uuid: "q2", parentUuid: "q1", type: "attachment", timestamp: at(4), attachment: { type: "queued_command", prompt: "<task-notification>x</task-notification>", commandMode: "task-notification" } },
    { uuid: "a2", parentUuid: "q2", type: "assistant", timestamp: at(5), message: { id: "msg_a2", role: "assistant", content: [{ type: "text", text: "done" }] } },
  ];
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const f = new StoreFile(path);
  await f.update();
  const msgs = chainMessages(f.chain());
  // Its id is the one Claude Code gives the prompt (source_uuid); the task's report stays hidden.
  expect(msgs.map((m) => `${m.id}:${(m.parts.find((p) => p.type === "text") as any)?.text ?? ""}`)).toEqual(["u1:first", "msg_a1:", "src1:also this", "msg_a2:done"]);
});

/** A session file from raw entries, read as a transcript. */
async function readRows(rows: any[]) {
  const path = join(mkdtempSync(join(tmpdir(), "tether-rows-")), "s.jsonl");
  writeFileSync(path, rows.map((r, i) => JSON.stringify({ timestamp: new Date(1_800_000_000_000 + i * 1000).toISOString(), ...r })).join("\n") + "\n");
  const f = new StoreFile(path);
  await f.update();
  return chainMessages(f.chain());
}

test("a `!` command reads as Claude Code shows it: `! cmd`, then its output", async () => {
  const u = (uuid: string, parentUuid: string | null, content: string) => ({ uuid, parentUuid, type: "user", message: { role: "user", content } });
  const msgs = await readRows([
    u("b1", null, "<bash-input>ls &amp;&amp; echo hi</bash-input>"),
    u("b2", "b1", "<bash-stdout>a.txt\nhi</bash-stdout><bash-stderr>warn: x &lt;y&gt;</bash-stderr>"),
    u("b3", "b2", "keep going\n\n<bash-input>git push</bash-input>\n<bash-stdout></bash-stdout><bash-stderr>Everything up-to-date</bash-stderr>"),
  ]);
  const show = (p: any) => (p.type === "tool" ? `${p.kind}:${p.status}:${p.command}:${p.output}` : p.text);
  expect(msgs.map((m) => `${m.id}|${m.parts.map(show).join("|")}`)).toEqual([
    "b1|! ls && echo hi|shell:done:ls && echo hi:a.txt\nhi\nwarn: x <y>",
    "b3|keep going|! git push|shell:done:git push:Everything up-to-date",
  ]);
});

test("/compact written both before and after its compaction shows once, before the notice", async () => {
  const msgs = await readRows([
    { uuid: "u1", parentUuid: null, type: "user", message: { role: "user", content: "hi" } },
    { uuid: "a1", parentUuid: "u1", type: "assistant", message: { id: "msg_a1", role: "assistant", content: [{ type: "text", text: "hello" }] } },
    { uuid: "c1", parentUuid: "a1", type: "user", message: { role: "user", content: "/compact" } },
    { uuid: "cb", parentUuid: null, logicalParentUuid: "a1", type: "system", subtype: "compact_boundary", content: "Conversation compacted" },
    { uuid: "s1", parentUuid: "cb", type: "user", isCompactSummary: true, message: { role: "user", content: "This session is being continued…" } },
    { uuid: "c2", parentUuid: "s1", type: "user", message: { role: "user", content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>" } },
    { uuid: "o1", parentUuid: "c2", type: "user", message: { role: "user", content: "<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>" } },
    { uuid: "u2", parentUuid: "o1", type: "user", message: { role: "user", content: "next" } },
  ]);
  expect(msgs.map((m) => `${m.role}:${(m.parts[0] as any)?.text}`)).toEqual(["user:hi", "assistant:hello", "user:/compact", "notice:Context compacted.", "user:next"]);
});
