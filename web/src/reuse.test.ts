import { expect, test } from "bun:test";
import type { Msg } from "./shared/protocol";
import { byId, reuseSame } from "./reuse";

const msg = (id: string, text: string): Msg => ({ id, role: "assistant", ts: 1, parts: [{ type: "text", text }] }) as Msg;

test("unchanged items keep their objects; changed and new ones come from the copy", () => {
  const prev = [msg("a", "one"), msg("b", "two")];
  const next = [msg("a", "one"), msg("b", "two, longer"), msg("c", "three")];
  const out = reuseSame(prev, next, byId);
  expect(out[0]).toBe(prev[0]!);
  expect(out[1]).toBe(next[1]!);
  expect(out[2]).toBe(next[2]!);
});

test("an identical copy returns the list on screen", () => {
  const prev = [msg("a", "one"), msg("b", "two")];
  expect(reuseSame(prev, structuredClone(prev), byId)).toBe(prev);
});

test("a reordered copy is a new list of the same objects", () => {
  const prev = [msg("a", "one"), msg("b", "two")];
  const out = reuseSame(prev, structuredClone(prev).reverse(), byId);
  expect(out).not.toBe(prev);
  expect(out[0]).toBe(prev[1]!);
  expect(out[1]).toBe(prev[0]!);
});

test("nothing on screen: the copy as it is", () => {
  const next = [msg("a", "one")];
  expect(reuseSame(undefined, next, byId)).toBe(next);
  expect(reuseSame([], next, byId)).toBe(next);
});

test("with a tail, only the last items are compared", () => {
  const prev = [msg("a", "one"), msg("b", "two"), msg("c", "three")];
  const out = reuseSame(prev, structuredClone(prev), byId, 2);
  expect(out).not.toBe(prev);
  expect(out[0]).not.toBe(prev[0]!);
  expect(out[1]).toBe(prev[1]!);
  expect(out[2]).toBe(prev[2]!);
});
