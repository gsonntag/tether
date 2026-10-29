import { expect, test } from "bun:test";
import type { SessionSnapshot } from "../../shared/transcript";
import { resubscriber, Subscriptions } from "./subscriptions";

const snap = (seq: number) => ({ seq }) as unknown as SessionSnapshot;
const noUnsub = async () => null;

test("every open session is subscribed again on resubscribe; closed ones aren't", async () => {
  const calls: string[] = [];
  let n = 0;
  const subs = new Subscriptions(async (r, s) => (calls.push(`${r}/${s}`), snap(++n)), noUnsub, { staggerMs: 0 });
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
  const subs = new Subscriptions(() => new Promise((ok) => pending.push(ok)), noUnsub, { staggerMs: 0 });
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
  const subs = new Subscriptions(() => new Promise((ok) => (release = ok)), noUnsub, { staggerMs: 0 });
  let got = 0;
  const close = subs.watch({ runnerId: "a", sessionId: "claude:1", onSnapshot: () => got++ });
  close();
  release(snap(1));
  await Bun.sleep(0);
  expect(got).toBe(0);
});

test("two watchers of one session share a subscription; it ends with the last one", async () => {
  const subscribes: string[] = [];
  const unsubs: string[] = [];
  const subs = new Subscriptions(async (r, s) => (subscribes.push(s), snap(subscribes.length)), async (r, s) => unsubs.push(s));
  const a: number[] = [];
  const b: number[] = [];
  const closeA = subs.watch({ runnerId: "r", sessionId: "claude:1", onSnapshot: (x) => a.push(x.seq) });
  await Bun.sleep(0);
  const closeB = subs.watch({ runnerId: "r", sessionId: "claude:1", onSnapshot: (x) => b.push(x.seq) });
  await Bun.sleep(0);
  // The second watcher's fresh snapshot reaches both.
  expect(a).toEqual([1, 2]);
  expect(b).toEqual([2]);
  expect(subs.size).toBe(1);
  closeA();
  expect(unsubs).toEqual([]);
  subs.resubscribe();
  await Bun.sleep(0);
  expect(a).toEqual([1, 2]);
  expect(b).toEqual([2, 3]);
  closeB();
  expect(unsubs).toEqual(["claude:1"]);
  expect(subs.size).toBe(0);
});

test("page load: hello resubscribes everything once; the runners list right after doesn't repeat it", () => {
  const calls: (string[] | undefined)[] = [];
  const r = resubscriber({ resubscribe: (ids?: string[]) => void calls.push(ids) });
  r.hello();
  r.runners(["a", "b"]);
  expect(calls).toEqual([undefined]);
  // Later, a runner reconnecting on its own does resubscribe its sessions.
  r.runners(["a"]);
  r.runners([]);
  expect(calls).toEqual([undefined, ["a"]]);
});

test("a reconnect resubscribes one session at a time, spaced out, and a closed one is skipped", async () => {
  const calls: string[] = [];
  const subs = new Subscriptions(async (_r, s) => (calls.push(s), snap(1)), noUnsub, { staggerMs: 20 });
  for (const s of ["claude:1", "claude:2"]) subs.watch({ runnerId: "a", sessionId: s, onSnapshot: () => {} });
  const close3 = subs.watch({ runnerId: "a", sessionId: "claude:3", onSnapshot: () => {} });
  calls.length = 0;
  subs.resubscribe();
  expect(calls).toEqual(["claude:1"]);
  await Bun.sleep(30);
  expect(calls).toEqual(["claude:1", "claude:2"]);
  close3();
  await Bun.sleep(40);
  expect(calls).toEqual(["claude:1", "claude:2"]);
});

test("refresh fetches one session again", async () => {
  const calls: string[] = [];
  const subs = new Subscriptions(async (_r, s) => (calls.push(s), snap(1)), noUnsub, { staggerMs: 0 });
  subs.watch({ runnerId: "a", sessionId: "claude:1", onSnapshot: () => {} });
  subs.watch({ runnerId: "a", sessionId: "claude:2", onSnapshot: () => {} });
  calls.length = 0;
  subs.refresh("a", "claude:2");
  subs.refresh("a", "claude:9");
  expect(calls).toEqual(["claude:2"]);
});
