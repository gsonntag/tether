import { expect, test } from "bun:test";
import { OpRegistry } from "./ops";

test("handlers answer, throw into errors, and unknown ops are named", async () => {
  const ops = new OpRegistry();
  ops.register("ping", () => ({ runnerId: "box", at: 1 }));
  ops.register("unsubscribe", () => {
    throw new Error("nope");
  });
  expect(await ops.handle("ping", {})).toEqual({ ok: true, data: { runnerId: "box", at: 1 } });
  expect(await ops.handle("unsubscribe", {})).toEqual({ ok: false, error: "nope" });
  const unknown = await ops.handle("frobnicate", {});
  expect(unknown.ok).toBe(false);
  expect(!unknown.ok && unknown.error).toContain("frobnicate");
  expect(() => ops.register("ping", () => ({ runnerId: "", at: 0 }))).toThrow();
});
