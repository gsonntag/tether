import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Msg } from "../../../../shared/transcript";

// The store lives under AGY_HOME: a throwaway one, set before the store module loads.
const home = mkdtempSync(join(tmpdir(), "tether-agy-fork-"));
process.env.AGY_HOME = home;
mkdirSync(join(home, "conversations"));
const { copyStore, discardStore, promptsKept, USER_INPUT_STEP } = await import("./fork");

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeStore(id: string) {
  const db = new Database(join(home, "conversations", `${id}.db`));
  db.exec("create table trajectory_meta (trajectory_id text primary key, cascade_id text)");
  db.exec("create table steps (idx integer primary key, step_type integer, step_payload blob)");
  db.exec("create table gen_metadata (idx integer primary key, data blob)");
  db.query("insert into trajectory_meta values (?, ?)").run("t-1", id);
  const blob = (s: string) => new Uint8Array(Buffer.from(`\x0a\x24${id}\x12${s}`, "latin1"));
  const steps: [number, number, string][] = [[0, USER_INPUT_STEP, "first"], [1, 15, "reply one"], [2, USER_INPUT_STEP, "second"], [3, 15, "reply two"]];
  for (const [idx, type, s] of steps) {
    db.query("insert into steps values (?, ?, ?)").run(idx, type, blob(s));
    db.query("insert into gen_metadata values (?, ?)").run(idx, blob(`gen ${s}`));
  }
  db.close();
}

test("a fork is the store copied under the new id, cut before the next prompt", () => {
  makeStore(A);
  mkdirSync(join(home, "brain", A), { recursive: true });
  writeFileSync(join(home, "brain", A, "plan.md"), "# plan");
  copyStore(A, B, 1);
  const db = new Database(join(home, "conversations", `${B}.db`), { readonly: true });
  expect(db.query("select cascade_id from trajectory_meta").get()).toEqual({ cascade_id: B });
  const steps = db.query("select idx, step_payload from steps order by idx").all() as { idx: number; step_payload: Uint8Array }[];
  expect(steps.map((s) => s.idx)).toEqual([0, 1]);
  for (const s of steps) {
    const text = Buffer.from(s.step_payload).toString("latin1");
    expect(text).toContain(B);
    expect(text).not.toContain(A);
  }
  expect((db.query("select count(*) as n from gen_metadata").get() as { n: number }).n).toBe(2);
  db.close();
  // The original is untouched.
  const orig = new Database(join(home, "conversations", `${A}.db`), { readonly: true });
  expect((orig.query("select count(*) as n from steps").get() as { n: number }).n).toBe(4);
  expect(orig.query("select cascade_id from trajectory_meta").get()).toEqual({ cascade_id: A });
  orig.close();
  expect(Bun.file(join(home, "brain", B, "plan.md")).size).toBeGreaterThan(0);
  discardStore(B);
  expect(Bun.file(join(home, "conversations", `${B}.db`)).size).toBe(0);
});

test("a whole fork keeps every step", () => {
  const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  copyStore(A, C);
  const db = new Database(join(home, "conversations", `${C}.db`), { readonly: true });
  expect((db.query("select count(*) as n from steps").get() as { n: number }).n).toBe(4);
  db.close();
});

test("the prompts a fork keeps: those up to the reply it ends at", () => {
  const m = (id: string, role: "user" | "assistant"): Msg => ({ id, role, parts: [], ts: 0 });
  const msgs = [m("m0", "user"), m("m1", "assistant"), m("m2", "user"), m("m3", "assistant")];
  expect(promptsKept(msgs, "m1")).toBe(1);
  expect(promptsKept(msgs, "m3")).toBe(2);
  expect(promptsKept(msgs)).toBeUndefined();
  expect(() => promptsKept(msgs, "m9")).toThrow("isn't in the session");
});
