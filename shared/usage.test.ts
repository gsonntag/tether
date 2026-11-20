import { expect, test } from "bun:test";
import { combineUsage, COMBINED_TOP_PROJECTS, emptyTotals, type UsageReport, type UsageTotals } from "./usage";

const t = (requests: number, usd: number, extra: Partial<UsageTotals> = {}): UsageTotals => {
  const x = { ...emptyTotals(), requests, usd, input: requests * 10, output: requests, ...extra };
  x.sources.plan = { requests, usd, unpriced: extra.unpriced ?? 0 };
  return x;
};

function report(o: Partial<UsageReport> & { days?: string[] } = {}): UsageReport {
  const days = (o.days as unknown as string[] | undefined) ?? ["2026-11-19", "2026-11-20"];
  return {
    days: days.length,
    timeZone: "America/Los_Angeles",
    from: days[0]!,
    to: days.at(-1)!,
    total: t(3, 3),
    byDay: days.map((day, i) => ({ day, ...t(i + 1, i + 1) })),
    byModel: [{ harness: "claude", model: "claude-opus-5-5", ...t(3, 3) }],
    byProject: [{ path: "/repo/a", name: "a", ...t(3, 3) }],
    plans: [],
    scan: { running: false, files: 10, done: 10, at: 1000, ms: 50, errors: 0 },
    ...o,
    ...(o.days ? { days: days.length } : {}),
  } as UsageReport;
}

test("totals, days and models add up across runners", () => {
  const c = combineUsage([
    { id: "r1", name: "Laptop", report: report() },
    { id: "r2", name: "Server", report: report({ total: t(5, 2), byModel: [{ harness: "claude", model: "claude-opus-5-5", ...t(4, 1) }, { harness: "codex", model: "gpt-6", ...t(1, 1) }] }) },
  ]);
  expect(c.total.requests).toBe(8);
  expect(c.total.usd).toBe(5);
  expect(c.total.sources.plan.requests).toBe(8);
  expect(c.byDay.map((d) => [d.day, d.requests])).toEqual([["2026-11-19", 2], ["2026-11-20", 4]]);
  expect(c.byModel.map((m) => [m.model, m.requests, m.usd])).toEqual([["claude-opus-5-5", 7, 4], ["gpt-6", 1, 1]]);
  expect(c.byRunner.map((r) => [r.name, r.requests])).toEqual([["Laptop", 3], ["Server", 5]]);
});

test("combining doesn't change the reports it was given", () => {
  const a = report();
  const before = JSON.stringify(a);
  combineUsage([{ id: "r1", name: "a", report: a }, { id: "r2", name: "b", report: report() }]);
  expect(JSON.stringify(a)).toBe(before);
});

test("days only some runners have still count, in order", () => {
  const c = combineUsage([
    { id: "r1", name: "a", report: report({ days: ["2026-11-19", "2026-11-20"] } as never) },
    { id: "r2", name: "b", report: report({ days: ["2026-11-20", "2026-11-21"] } as never) },
  ]);
  expect(c.byDay.map((d) => d.day)).toEqual(["2026-11-19", "2026-11-20", "2026-11-21"]);
  expect(c.from).toBe("2026-11-19");
  expect(c.to).toBe("2026-11-21");
});

test("projects merge by folder, re-rank, and the rest fold into one row", () => {
  const many = Array.from({ length: COMBINED_TOP_PROJECTS }, (_, i) => ({ path: `/p/${i}`, name: `${i}`, ...t(1, i + 1) }));
  const c = combineUsage([
    { id: "r1", name: "a", report: report({ byProject: [...many, { name: "3 other projects", others: 3, ...t(3, 0.3) }, { name: "Hidden projects", hidden: true, ...t(1, 1) }] }) },
    { id: "r2", name: "b", report: report({ byProject: [{ path: "/p/0", name: "0", ...t(1, 100) }, { path: "/q", name: "q", ...t(1, 0.1) }, { name: "Unknown folder", ...t(1, 0.05) }] }) },
  ]);
  expect(c.byProject[0]).toMatchObject({ path: "/p/0", usd: 101, requests: 2 });
  expect(c.byProject.filter((p) => p.path || (!p.others && !p.hidden))).toHaveLength(COMBINED_TOP_PROJECTS);
  const other = c.byProject.find((p) => p.others)!;
  // the runner's 3, /q and the unknown folder
  expect(other.others).toBe(5);
  expect(other.name).toBe("5 other projects");
  expect(c.byProject.at(-1)).toMatchObject({ hidden: true, requests: 1 });
});

test("one project over the top keeps its name", () => {
  const many = Array.from({ length: COMBINED_TOP_PROJECTS + 1 }, (_, i) => ({ path: `/p/${i}`, name: `${i}`, ...t(1, 20 - i) }));
  const c = combineUsage([{ id: "r1", name: "a", report: report({ byProject: many.slice(0, 5) }) }, { id: "r2", name: "b", report: report({ byProject: many.slice(5) }) }]);
  expect(c.byProject.map((p) => p.name)).toEqual(many.map((p) => p.name));
});

test("the ledger, plans and scan combine", () => {
  const plan = { harness: "claude" as const, label: "Claude", plan: {} as never };
  const c = combineUsage([
    { id: "r1", name: "Laptop", report: report({ ledger: { usd: 1, sessions: 2, complete: true }, plans: [plan], scan: { running: true, files: 10, done: 4, at: 500, errors: 1 } }) },
    { id: "r2", name: "Server", report: report({ ledger: { usd: 2, sessions: 1, complete: false }, plans: [plan], scan: { running: false, files: 5, done: 5, at: 900, errors: 0, skipped: 2 } }) },
  ]);
  expect(c.ledger).toEqual({ usd: 3, sessions: 3, complete: false });
  expect(c.plans.map((p) => p.label)).toEqual(["Claude · Laptop", "Claude · Server"]);
  expect(c.scan).toMatchObject({ running: true, files: 15, done: 9, at: 500, errors: 1, skipped: 2 });
  // One runner never read: not "read just now".
  const never = combineUsage([{ id: "r1", name: "a", report: report() }, { id: "r2", name: "b", report: report({ scan: { running: true, files: 0, done: 0, errors: 0 } }) }]);
  expect(never.scan.at).toBeUndefined();
});

test("no reports is an empty report", () => {
  const c = combineUsage([]);
  expect(c.total.requests).toBe(0);
  expect(c.byDay).toEqual([]);
  expect(c.byRunner).toEqual([]);
});
