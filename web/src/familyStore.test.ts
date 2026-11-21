import { expect, test } from "bun:test";
import type { SpawnedFamily } from "../../shared/protocol";
import { familyKeyOf, forgetFamilies, loadFamily, useFamilies } from "./familyStore";

test("the Sidebar and the header share one ask per session and key", async () => {
  const none = () => ({});
  const calls: string[] = [];
  let answer: (f: SpawnedFamily) => void = () => {};
  const ask = (_r: string, s: string) => (calls.push(s), new Promise<SpawnedFamily>((r) => (answer = r)));
  loadFamily("a", "s1", "k", none, ask);
  loadFamily("a", "s1", "k", none, ask);
  expect(calls).toEqual(["s1"]);
  answer({ children: [] });
  await new Promise((r) => setTimeout(r, 0));
  expect(useFamilies.getState().by[familyKeyOf("a", "s1")]?.f).toEqual({ children: [] });
  // Something it was for changed: asked again.
  loadFamily("a", "s1", "k2", none, ask);
  expect(calls).toEqual(["s1", "s1"]);
  forgetFamilies();
  expect(useFamilies.getState().by).toEqual({});
});
