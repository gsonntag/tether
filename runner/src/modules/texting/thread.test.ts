import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileThread, threadDir } from "./thread";

describe("FileThread", () => {
  test("reads live textme waiters, drops dead ones, skips expired ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "thread-"));
    const now = 1_000_000;
    writeFileSync(join(dir, "textme-11.json"), JSON.stringify({ kind: "textme", pid: 11, sentAt: now - 10, until: now + 1000, id: "m1" }));
    writeFileSync(join(dir, "textme-12.json"), JSON.stringify({ kind: "textme", pid: 12, sentAt: now - 10, until: now + 1000 }));
    writeFileSync(join(dir, "textme-13.json"), JSON.stringify({ kind: "textme", pid: 13, sentAt: now - 10, until: now - 1 }));
    writeFileSync(join(dir, "textme-14.json"), "{broken");
    const t = new FileThread(dir, (pid) => pid !== 12);
    expect(t.waiters(now)).toEqual([{ pid: 11, sentAt: now - 10, until: now + 1000, id: "m1" }]);
    expect(existsSync(join(dir, "textme-12.json"))).toBe(false);
    expect(existsSync(join(dir, "textme-13.json"))).toBe(true);
  });

  test("publishes and clears its own note", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "thread-")), "sub");
    const t = new FileThread(dir);
    t.publish({ lastOut: 5, open: [{ n: 1, until: 9 }], sent: ["a"] });
    const file = join(dir, `tether-${process.pid}.json`);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ kind: "tether", pid: process.pid, lastOut: 5, open: [{ n: 1, until: 9 }], sent: ["a"] });
    t.clear();
    expect(existsSync(file)).toBe(false);
  });

  test("a missing folder is no waiters", () => {
    expect(new FileThread("/nonexistent/x").waiters(0)).toEqual([]);
    expect(threadDir({ XDG_STATE_HOME: "/s" })).toBe("/s/imessage-thread");
    expect(threadDir({ IMESSAGE_THREAD_DIR: "/d", XDG_STATE_HOME: "/s" })).toBe("/d");
  });
});
