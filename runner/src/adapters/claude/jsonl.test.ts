import { beforeAll, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transcript } from "../../core/transcript";
import { chainMessages, readHistory } from "./history";
import { StoreFile } from "./jsonl";

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
function file(rows: [string, string | null, "user" | "assistant", string | { tool_result: true }, string?][]) {
  const dir = mkdtempSync(join(tmpdir(), "tether-branch-"));
  const path = join(dir, "b.jsonl");
  writeFileSync(
    path,
    rows
      .map(([uuid, parentUuid, type, text, origin], i) =>
        JSON.stringify({
          uuid,
          ...(origin ? { origin: { kind: origin } } : {}),
          parentUuid,
          type,
          timestamp: new Date(1_800_000_000_000 + i * 1000).toISOString(),
          message:
            type === "assistant"
              ? { id: `msg_${uuid}`, role: "assistant", content: [{ type: "text", text }] }
              : { role: "user", content: typeof text === "string" ? text : [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
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
