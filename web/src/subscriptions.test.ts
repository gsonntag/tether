import { expect, test } from "bun:test";
import type { SessionSnapshot } from "../../shared/transcript";
import { Subscriptions } from "./subscriptions";

const snap = (seq: number) => ({ seq }) as unknown as SessionSnapshot;

test("every open session is subscribed again on resubscribe; closed ones aren't", async () => {
  const calls: string[] = [];
  let n = 0;
  const subs = new Subscriptions(async (r, s) => (calls.push(`${r}/${s}`), snap(++n)));
  const got: number[] = [];
  subs.watch({ runnerId: "a", sessionId: "claude:1", onSnapshot: (x) => got.push(x.seq) });
  const close = subs.watch({ runnerId: "b", sessionId: "claude:2", onSnapshot: () => {} });
  await Bun.sleep(0);
  subs.resubscribe();
  await Bun.sleep(0);
  expect(calls).toEqual(["a/claude:1", "b/claude:2", "a/claude:1", "b/claude:2"]);
  close();
  calls.length = 0;
  subs.resubscribe(["a", "b"]);
  await Bun.sleep(0);
  expect(calls).toEqual(["a/claude:1"]);
  subs.resubscribe(["b"]);
  await Bun.sleep(0);
  expect(calls).toEqual(["a/claude:1"]);
  expect(got.length).toBe(3);
});

test("a snapshot for a session closed in the meantime is dropped", async () => {
  let release!: (s: SessionSnapshot) => void;
  const subs = new Subscriptions(() => new Promise((ok) => (release = ok)));
  let got = 0;
  const close = subs.watch({ runnerId: "a", sessionId: "claude:1", onSnapshot: () => got++ });
  close();
  release(snap(1));
  await Bun.sleep(0);
  expect(got).toBe(0);
});
