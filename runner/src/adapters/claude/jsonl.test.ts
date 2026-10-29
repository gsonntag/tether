import { beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
