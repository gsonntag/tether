import { afterEach, expect, setSystemTime, test } from "bun:test";
import { noteOpened, reader } from "./store";

const r = reader as any;
const realUse = r.use;
afterEach(() => {
  r.use = realUse;
  setSystemTime();
});

test("a failed refresh after the cache ages out keeps the last options", async () => {
  setSystemTime(new Date("2026-11-28T00:00:00Z"));
  noteOpened({ configOptions: [{ id: "model", currentValue: "m1" }], models: { availableModels: [{ modelId: "m1" }] } });
  setSystemTime(new Date("2026-11-28T00:11:00Z"));
  let calls = 0;
  r.use = async () => {
    calls++;
    throw new Error("agy timed out");
  };
  const [a, b] = await Promise.all([reader.configInfo(), reader.configInfo()]);
  expect(a.config).toEqual([{ id: "model", currentValue: "m1" }]);
  expect(a.availableModels).toEqual([{ modelId: "m1" }]);
  expect(b.config).toEqual(a.config);
  expect(calls).toBe(1);
});

test("a fresh cache is used without asking Antigravity", async () => {
  setSystemTime(new Date("2026-11-28T01:00:00Z"));
  noteOpened({ configOptions: [{ id: "model", currentValue: "m2" }] });
  r.use = async () => {
    throw new Error("should not be called");
  };
  expect((await reader.configInfo()).config).toEqual([{ id: "model", currentValue: "m2" }]);
});
