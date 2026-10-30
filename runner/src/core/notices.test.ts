// Tether's notices and `!` cards on disk: cards in a file per session, only what changed written.

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Msg } from "../../../shared/transcript";
import { NoticeStore } from "./notices";

const notice = (id: string): Msg => ({ id, role: "notice", ts: 1, parts: [{ type: "text", text: id }] });
const card = (id: string, state: "running" | "sent" = "sent", ts = 2): Msg => ({ id, role: "user", ts, parts: [], shell: { state, startedAt: ts } });

test("cards go to their session's own file; a card change rewrites only that file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tether-notices-"));
  const file = join(dir, "notices.json");
  const s = new NoticeStore(file);
  s.add("a", { msg: notice("n-1") });
  s.add("a", { msg: card("n-sh-1") });
  s.add("b", { msg: card("n-sh-2") });
  s.flush();
  expect(readFileSync(file, "utf8")).not.toContain("n-sh-");
  expect(readdirSync(join(dir, "shell-cards"))).toHaveLength(2);
  const before = statSync(file).mtimeMs;
  await Bun.sleep(20);
  s.update("b", { ...card("n-sh-2"), ts: 3 });
  s.flush();
  expect(statSync(file).mtimeMs).toBe(before);
  // Read back together, in order.
  const again = new NoticeStore(file);
  expect(again.get("a").map((n) => n.msg.id)).toEqual(["n-1", "n-sh-1"]);
  expect(again.get("b")[0]!.msg.ts).toBe(3);
});

test("a running card is never dropped for later ones; cards are kept apart from the 50 notices", () => {
  const s = new NoticeStore();
  s.add("a", { msg: card("n-sh-run", "running", 1) });
  for (let i = 0; i < 40; i++) s.add("a", { msg: card(`n-sh-${i}`, "sent", 10 + i) });
  for (let i = 0; i < 60; i++) s.add("a", { msg: notice(`n-${i}`) });
  const ids = s.get("a").map((n) => n.msg.id);
  expect(ids).toContain("n-sh-run");
  expect(ids.filter((x) => x.startsWith("n-sh-"))).toHaveLength(31);
  expect(ids.filter((x) => !x.startsWith("n-sh-"))).toHaveLength(50);
});

test("cards an older runner kept in notices.json move to their own files", () => {
  const dir = mkdtempSync(join(tmpdir(), "tether-notices-"));
  const file = join(dir, "notices.json");
  writeFileSync(file, JSON.stringify({ a: { at: 1, notices: [{ msg: notice("n-1") }, { msg: card("n-sh-1") }] } }));
  const s = new NoticeStore(file);
  s.flush();
  expect(readFileSync(file, "utf8")).not.toContain("n-sh-1");
  expect(existsSync(join(dir, "shell-cards"))).toBe(true);
  expect(new NoticeStore(file).get("a").map((n) => n.msg.id)).toEqual(["n-1", "n-sh-1"]);
});
