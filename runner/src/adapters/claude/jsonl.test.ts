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
  // The SDK's walk stopped at the last compaction: 4 prompts. The whole conversation has 246.
  expect(msgs.filter((m) => m.role === "user").length).toBe(246);
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
