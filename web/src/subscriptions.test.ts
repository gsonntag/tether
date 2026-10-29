import { expect, test } from "bun:test";
import type { SessionSnapshot } from "../../shared/transcript";
import { Subscriptions } from "./subscriptions";

const snap = (seq: number) => ({ seq }) as unknown as SessionSnapshot;
const noUnsub = async () => null;

test("every open session is subscribed again on resubscribe; closed ones aren't", async () => {
  const calls: string[] = [];
  let n = 0;
  const subs = new Subscriptions(async (r, s) => (calls.push(`${r}/${s}`), snap(++n)), noUnsub);
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
  expect(got.length).toBe(3);
});

test("closing a session view unsubscribes it on the server, once", async () => {
  const unsubs: string[] = [];
  const subs = new Subscriptions(async () => snap(1), async (r, s) => unsubs.push(`${r}/${s}`));
  const close = subs.watch({ runnerId: "a", sessionId: "claude:1", onSnapshot: () => {} });
  close();
  close();
  expect(unsubs).toEqual(["a/claude:1"]);
  expect(subs.size).toBe(0);
});

test("a failing unsubscribe (link already down) is quiet", async () => {
  const subs = new Subscriptions(async () => snap(1), () => Promise.reject(new Error("Not connected.")));
  subs.watch({ runnerId: "a", sessionId: "claude:1", onSnapshot: () => {} })();
  await Bun.sleep(0);
});

test("overlapping subscribes: only the newest answer is applied, whatever order they finish in", async () => {
  const pending: ((s: SessionSnapshot) => void)[] = [];
  const subs = new Subscriptions(() => new Promise((ok) => pending.push(ok)), noUnsub);
  const got: number[] = [];
  subs.watch({ runnerId: "a", sessionId: "claude:1", onSnapshot: (x) => got.push(x.seq) });
  subs.resubscribe();
  pending[1]!(snap(20));
  pending[0]!(snap(10));
  await Bun.sleep(0);
  expect(got).toEqual([20]);
});

test("a snapshot for a session closed in the meantime is dropped", async () => {
  let release!: (s: SessionSnapshot) => void;
  const subs = new Subscriptions(() => new Promise((ok) => (release = ok)), noUnsub);
  let got = 0;
  const close = subs.watch({ runnerId: "a", sessionId: "claude:1", onSnapshot: () => got++ });
  close();
  release(snap(1));
  await Bun.sleep(0);
  expect(got).toBe(0);
});
