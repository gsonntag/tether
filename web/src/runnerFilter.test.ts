import { expect, test } from "bun:test";
import { activeRunnerFilter, aggregateProjects, filterRowsByRunner, loadRunnerFilter, saveRunnerFilter } from "./runnerFilter";
import type { Row } from "./sessionList";
import type { ProjectInfo } from "../../shared/transcript";

test("activeRunnerFilter: falls back to undefined (All) when <= 1 runner is online", () => {
  expect(activeRunnerFilter("r1", [])).toBeUndefined();
  expect(activeRunnerFilter("r1", [{ id: "r1" }])).toBeUndefined();
  expect(activeRunnerFilter("r1", [{ id: "r2" }])).toBeUndefined();
});

test("activeRunnerFilter: returns chosen runner when multiple runners online and chosen is present", () => {
  const online = [{ id: "r1" }, { id: "r2" }];
  expect(activeRunnerFilter("r1", online)).toBe("r1");
  expect(activeRunnerFilter("r2", online)).toBe("r2");
  expect(activeRunnerFilter(undefined, online)).toBeUndefined();
});

test("activeRunnerFilter: falls back to undefined (All) when chosen runner is offline or gone", () => {
  const online = [{ id: "r2" }, { id: "r3" }];
  expect(activeRunnerFilter("r1", online)).toBeUndefined();
});

test("filterRowsByRunner: filters rows by runnerId or returns all", () => {
  const rows = [
    { id: "s1", runnerId: "r1" },
    { id: "s2", runnerId: "r2" },
    { id: "s3", runnerId: "r1" },
  ] as Row[];

  expect(filterRowsByRunner(rows, "r1").map((r) => r.id)).toEqual(["s1", "s3"]);
  expect(filterRowsByRunner(rows, "r2").map((r) => r.id)).toEqual(["s2"]);
  expect(filterRowsByRunner(rows, undefined).map((r) => r.id)).toEqual(["s1", "s2", "s3"]);
  expect(filterRowsByRunner(rows, "r3")).toEqual([]);
});

test("aggregateProjects: combines projects across runners, or isolates a chosen runner", () => {
  const p1: ProjectInfo = { path: "/code/web", name: "web", harnesses: ["claude"], updatedAt: 100, sessions: 2 };
  const p2: ProjectInfo = { path: "/code/api", name: "api", harnesses: ["claude"], updatedAt: 200, sessions: 3 };
  const p3: ProjectInfo = { path: "/code/web", name: "web", harnesses: ["claude"], updatedAt: 150, sessions: 4 };

  const projectsBy: Record<string, ProjectInfo[]> = {
    r1: [p1, p2],
    r2: [p3],
  };

  // All runners: merges /code/web from r1 and r2
  const all = aggregateProjects(projectsBy);
  expect(all).toHaveLength(2);
  expect(all[0]!.path).toBe("/code/api"); // updatedAt: 200
  expect(all[1]!.path).toBe("/code/web"); // updatedAt: max(100, 150) = 150
  expect(all[1]!.sessions).toBe(6); // 2 + 4
  expect(all[1]!.runnerIds).toEqual(["r1", "r2"]);

  // Filtered to r1: only r1's projects
  const r1Only = aggregateProjects(projectsBy, "r1");
  expect(r1Only).toHaveLength(2);
  expect(r1Only.map((p) => p.path)).toEqual(["/code/api", "/code/web"]);
  expect(r1Only.find((p) => p.path === "/code/web")?.sessions).toBe(2);
  expect(r1Only.find((p) => p.path === "/code/web")?.runnerIds).toEqual(["r1"]);

  // Filtered to r2: only r2's projects
  const r2Only = aggregateProjects(projectsBy, "r2");
  expect(r2Only).toHaveLength(1);
  expect(r2Only[0]!.path).toBe("/code/web");
  expect(r2Only[0]!.sessions).toBe(4);
  expect(r2Only[0]!.runnerIds).toEqual(["r2"]);

  // Filtered to unknown runner: empty
  expect(aggregateProjects(projectsBy, "r3")).toEqual([]);
});

test("loadRunnerFilter and saveRunnerFilter: persist preference in storage", () => {
  const map = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => map.set(k, v),
    removeItem: (k: string) => map.delete(k),
  } as unknown as Storage;

  expect(loadRunnerFilter(mockStorage)).toBeUndefined();
  saveRunnerFilter("runner-1", mockStorage);
  expect(loadRunnerFilter(mockStorage)).toBe("runner-1");
  saveRunnerFilter(undefined, mockStorage);
  expect(loadRunnerFilter(mockStorage)).toBeUndefined();
});

test("New Session default runner: uses filtered runner if online, else first online runner", () => {
  const online = [{ id: "r1" }, { id: "r2" }];
  const defaultFor = (filter?: string) => (filter && online.some((r) => r.id === filter) ? filter : undefined) ?? online[0]?.id;
  expect(defaultFor("r2")).toBe("r2");
  expect(defaultFor("r1")).toBe("r1");
  expect(defaultFor("r3")).toBe("r1");
  expect(defaultFor(undefined)).toBe("r1");
});
