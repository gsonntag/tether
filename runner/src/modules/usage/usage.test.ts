import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexLine, claudeLine, FAST, LONG, US_GEO, type FileState, type Rec } from "./parse";
import { priceRec } from "./price";
import { buildReport, codexSource, dayKeyer, dayRange, TOP_PROJECTS } from "./report";
import { claudeSession, UsageScanner } from "./scan";

// Recent, so the scanner keeps it (it drops records older than its window).
const T = new Date(Date.now() - 3_600_000).toISOString();
const assistant = (o: { id: string; req?: string; model?: string; ts?: string; cwd?: string; sidechain?: boolean; usage?: any }) =>
  JSON.stringify({
    type: "assistant",
    uuid: crypto.randomUUID(),
    requestId: o.req ?? `req_${o.id}`,
    timestamp: o.ts ?? T,
    cwd: o.cwd ?? "/work/app",
    isSidechain: !!o.sidechain,
    message: { id: o.id, model: o.model ?? "claude-opus-5-5", usage: { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 50 }, service_tier: "standard", ...o.usage } },
  });
const usage = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
const tokenCount = (ts: string, total: number, last: any, plan?: string) =>
  JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, last_token_usage: last }, rate_limits: plan ? { plan_type: plan } : null } });
const meta = (id: string, cwd: string, provider = "openai") => JSON.stringify({ timestamp: T, type: "session_meta", payload: { id, cwd, model_provider: provider } });
const turn = (model: string) => JSON.stringify({ timestamp: T, type: "turn_context", payload: { model, cwd: "/elsewhere" } });

const fresh = (harness: "claude" | "codex"): FileState => ({ harness, size: 0, mtime: 0, offset: 0, head: "", recs: [] });
const feed = (harness: "claude" | "codex", lines: string[]) => {
  const f = fresh(harness);
  const index = new Map<string, number>();
  for (const l of lines) (harness === "claude" ? claudeLine : codexLine)(l, f, index);
  return f;
};

describe("Claude lines", () => {
  test("a streamed message's entries are one request, at its largest counts", () => {
    const f = feed("claude", [
      assistant({ id: "m1", usage: { output_tokens: 10 } }),
      assistant({ id: "m1", usage: { output_tokens: 300 } }),
      assistant({ id: "m1", usage: { output_tokens: 300 } }),
      assistant({ id: "m2" }),
    ]);
    expect(f.recs.length).toBe(2);
    expect(f.recs[0]![4]).toBe(300);
    expect(f.project).toBe("/work/app");
  });
  test("sidechains count; synthetic messages, compaction boundaries, user lines and torn lines don't", () => {
    const f = feed("claude", [
      assistant({ id: "m1", sidechain: true }),
      assistant({ id: "m2", model: "<synthetic>" }),
      JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: T, compactMetadata: { preTokens: 900000 } }),
      JSON.stringify({ type: "user", timestamp: T, message: { content: "what's in \"usage\" of the \"assistant\"?" } }),
      assistant({ id: "m3" }).slice(0, 80),
    ]);
    expect(f.recs.map((r) => r[2])).toEqual(["claude-opus-5-5"]);
  });
  test("cache writes split by lifetime; fast and US-only inference are marked; an unknown model is kept", () => {
    const f = feed("claude", [
      assistant({ id: "m1", usage: { cache_creation_input_tokens: 70, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 50 }, speed: "fast", inference_geo: "us" } }),
      assistant({ id: "m2", model: "claude-future-9", usage: { cache_creation: undefined } }),
    ]);
    const [a, b] = f.recs as [Rec, Rec];
    expect([a[6], a[7], a[8]]).toEqual([20, 50, FAST | US_GEO]);
    // No breakdown: all at the 5-minute rate.
    expect([b[2], b[6], b[7]]).toEqual(["claude-future-9", 50, 0]);
  });
  test("a subagent's file belongs to its session", () => {
    expect(claudeSession("/p/-work-app/abc.jsonl")).toBe("abc");
    expect(claudeSession("/p/-work-app/abc/subagents/agent-x.jsonl")).toBe("abc");
    expect(claudeSession("/p/-work-app/abc/subagents/workflows/wf_1/agent-y.jsonl")).toBe("abc");
  });
});

describe("Codex lines", () => {
  test("token counts: each moved total is a response; a repeat is the same report; a fork's inherited total isn't counted", () => {
    const f = feed("codex", [
      meta("t1", "/work/cx"),
      turn("gpt-6-luna"),
      // A fork: the total starts with the parent's 14,000.
      tokenCount("2026-11-17T20:00:01Z", 15_000, usage(900, 400, 100), "plus"),
      tokenCount("2026-11-17T20:00:02Z", 15_000, usage(900, 400, 100), "plus"),
      turn("gpt-6.1-sol"),
      tokenCount("2026-11-17T20:00:03Z", 16_000, usage(950, 900, 50)),
      JSON.stringify({ timestamp: T, type: "event_msg", payload: { type: "token_count", info: null, rate_limits: { plan_type: "plus" } } }),
    ]);
    expect(f.recs.map((r) => [r[2], r[3], r[4], r[5]])).toEqual([["gpt-6-luna", 500, 100, 400], ["gpt-6.1-sol", 50, 50, 900]]);
    expect([f.session, f.project, f.provider, f.plan]).toEqual(["t1", "/work/cx", "openai", true]);
    expect(codexSource(f)).toBe("plan");
  });
  test("once a file has usage records they're what counts, by response id", () => {
    const record = (id: string, u: any) => JSON.stringify({ timestamp: T, type: "token_usage_record", payload: { response_id: id, usage: u } });
    const f = feed("codex", [
      meta("t2", "/work/cx", "tether_openai"),
      turn("gpt-6-luna"),
      tokenCount("2026-11-17T19:00:00Z", 1000, usage(900, 0, 100)),
      record("resp_1", usage(300_000, 0, 10)),
      tokenCount("2026-11-17T20:00:01Z", 301_010, usage(300_000, 0, 10)),
      record("resp_1", usage(300_000, 0, 10)),
    ]);
    expect(f.recs.length).toBe(2);
    expect(f.recs[1]![8]).toBe(LONG);
    expect(codexSource(f)).toBe("key");
    expect(codexSource({ ...fresh("codex"), provider: "openai" })).toBe("unknown");
    expect(codexSource({ ...fresh("codex"), provider: "openai", private: true })).toBe("key");
  });
});

describe("prices", () => {
  const rec = (model: string, input: number, output: number, read: number, w1: number, w2: number, flags = 0): Rec => ["k", 0, model, input, output, read, w1, w2, flags];
  test("Claude at the published rates, with cache savings", () => {
    // Opus 5.5: $4 in, $20 out, $0.20 read, $5 / $8 writes.
    const p = priceRec("claude", rec("claude-opus-5-5", 1e6, 1e6, 1e6, 1e6, 1e6))!;
    expect(p.usd).toBeCloseTo(4 + 20 + 0.2 + 5 + 8);
    expect(p.savings).toBeCloseTo(3.8);
    expect(priceRec("claude", rec("claude-opus-5-5", 1e6, 0, 0, 0, 0, FAST))!.usd).toBeCloseTo(8);
    expect(priceRec("claude", rec("claude-opus-5-5", 1e6, 0, 0, 0, 0, US_GEO))!.usd).toBeCloseTo(4.4);
    expect(priceRec("claude", rec("claude-sonnet-5-5", 1e6, 0, 0, 0, 0, FAST))).toBeUndefined();
    expect(priceRec("claude", rec("claude-future-9", 1, 1, 1, 1, 1))).toBeUndefined();
  });
  test("Haiku 5.5 prices a prompt over 100K tokens at its long rates", () => {
    expect(priceRec("claude", rec("claude-haiku-5-5", 50_000, 0, 50_000, 0, 0))!.usd).toBeCloseTo((50_000 * 0.1 + 50_000 * 0.01) / 1e6);
    expect(priceRec("claude", rec("claude-haiku-5-5", 50_000, 0, 50_001, 0, 0))!.usd).toBeCloseTo((50_000 * 0.5 + 50_001 * 0.05) / 1e6);
  });
  test("Codex at OpenAI's Standard rates; long context, Azure and unlisted models aren't priced", () => {
    expect(priceRec("codex", rec("gpt-6-luna", 1e6, 1e6, 1e6, 1e6, 0), "openai")!.usd).toBeCloseTo(0.1 + 0.5 + 0.01 + 0.125);
    expect(priceRec("codex", rec("gpt-6-luna", 1, 1, 0, 0, 0, LONG), "openai")).toBeUndefined();
    expect(priceRec("codex", rec("gpt-6-luna", 1, 1, 0, 0, 0), "tether_azure")).toBeUndefined();
    expect(priceRec("codex", rec("gpt-5.6-luna", 1, 1, 0, 0, 0), "openai")).toBeUndefined();
  });
});

describe("report", () => {
  const NOW = Date.parse("2026-11-18T12:00:00Z");
  const file = (harness: "claude" | "codex", project: string, recs: Rec[], extra: Partial<FileState> = {}): FileState => ({ ...fresh(harness), project, recs, ...extra });
  const r = (key: string, iso: string, model = "claude-opus-5-5", out = 1000): Rec => [key, Date.parse(iso) / 1000, model, 0, out, 0, 0, 0, 0];

  test("days are the browser's: an evening in California is that day there, not UTC's next", () => {
    const key = dayKeyer("America/Los_Angeles");
    expect(key(Date.parse("2026-11-18T03:00:00Z") / 1000)).toBe("2026-11-17");
    expect(dayKeyer("UTC")(Date.parse("2026-11-18T03:00:00Z") / 1000)).toBe("2026-11-18");
    // Quarter-hour zones.
    expect(dayKeyer("Asia/Kathmandu")(Date.parse("2026-11-17T18:15:00Z") / 1000)).toBe("2026-11-18");
    expect(dayKeyer("Asia/Kathmandu")(Date.parse("2026-11-17T18:14:59Z") / 1000)).toBe("2026-11-17");
    expect(dayRange("2026-03-02", 3)).toEqual(["2026-02-28", "2026-03-01", "2026-03-02"]);
    const files: [string, FileState][] = [["a", file("claude", "/w/a", [r("1", "2026-11-18T03:00:00Z")])]];
    const la = buildReport({ files, days: 7, timeZone: "America/Los_Angeles", now: NOW, source: () => "plan" });
    const utc = buildReport({ files, days: 7, timeZone: "UTC", now: NOW, source: () => "plan" });
    expect(la.byDay.find((d) => d.requests)!.day).toBe("2026-11-17");
    expect(utc.byDay.find((d) => d.requests)!.day).toBe("2026-11-18");
    expect([la.from, la.to, la.byDay.length]).toEqual(["2026-11-12", "2026-11-18", 7]);
  });

  test("a request in two files counts once; old ones fall out; dollars split by source; unpriced counted apart", () => {
    const files: [string, FileState][] = [
      ["/a", file("claude", "/w/a", [r("dup", "2026-11-18T01:00:00Z"), r("old", "2026-10-01T00:00:00Z")], { session: "s1" })],
      ["/b", file("claude", "/w/a", [r("dup", "2026-11-18T01:00:00Z"), r("x", "2026-11-18T02:00:00Z", "claude-future-9")], { session: "s2" })],
      ["/c", file("codex", "/w/c", [r("c1", "2026-11-18T02:00:00Z", "gpt-6-luna", 1e6)], { provider: "openai", plan: true, session: "t1" })],
    ];
    const rep = buildReport({
      files, days: 30, timeZone: "UTC", now: NOW,
      source: (f) => (f.harness === "codex" ? codexSource(f) : f.session === "s1" ? "key" : "unknown"),
      ledger: (id) => (id === "claude:s1" ? { usd: 1.5, complete: true } : undefined),
    });
    expect(rep.total.requests).toBe(3);
    expect(rep.total.unpriced).toBe(1);
    expect(rep.total.key).toBeCloseTo(0.02);
    expect(rep.total.plan).toBeCloseTo(0.5);
    expect(rep.total.usd).toBeCloseTo(0.52);
    expect(rep.byModel.map((m) => [m.harness, m.model, m.requests])).toEqual([["codex", "gpt-6-luna", 1], ["claude", "claude-opus-5-5", 1], ["claude", "claude-future-9", 1]]);
    expect(rep.ledger).toEqual({ usd: 1.5, sessions: 1, complete: true });
  });

  test("the top projects, the rest together, hidden ones apart and unnamed", () => {
    const files: [string, FileState][] = Array.from({ length: TOP_PROJECTS + 3 }, (_, i) => [`/f${i}`, file("claude", `/w/p${i}`, [r(`k${i}`, "2026-11-18T01:00:00Z", "claude-opus-5-5", (i + 1) * 1000)])]);
    files.push(["/h", file("claude", "/tmp/scratch", [r("h", "2026-11-18T01:00:00Z")])]);
    const rep = buildReport({ files, days: 30, timeZone: "UTC", now: NOW, source: () => "plan", hidden: (p) => p.startsWith("/tmp/") });
    expect(rep.byProject.length).toBe(TOP_PROJECTS + 2);
    expect(rep.byProject[0]!.name).toBe(`p${TOP_PROJECTS + 2}`);
    expect(rep.byProject.at(-2)).toMatchObject({ name: "3 other projects", others: 3, requests: 3 });
    expect(rep.byProject.at(-1)).toMatchObject({ name: "Hidden projects", hidden: true, requests: 1 });
    expect(rep.byProject.at(-1)!.path).toBeUndefined();
  });
});

describe("scanner", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "usage-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const roots = () => [{ harness: "claude" as const, dir: join(dir, "projects") }, { harness: "codex" as const, dir: join(dir, "codex") }];
  const total = (s: UsageScanner) => [...s.files.values()].reduce((n, f) => n + f.recs.length, 0);

  test("reads only what's new, waits for a torn last line, and re-reads a file that shrank or was replaced", async () => {
    const p = join(dir, "projects", "-w-a");
    mkdirSync(p, { recursive: true });
    const f = join(p, "s1.jsonl");
    const torn = assistant({ id: "m2" });
    writeFileSync(f, assistant({ id: "m1" }) + "\n" + torn.slice(0, 50));
    const cache = join(dir, "cache.json");
    const s = new UsageScanner({ roots, cacheFile: cache, chunk: 64 });
    await s.scan();
    expect(total(s)).toBe(1);
    const st = s.files.get(f)!;
    expect(st.offset).toBe(assistant({ id: "m1" }).length + 1);
    expect(st.session).toBe("s1");

    appendFileSync(f, torn.slice(50) + "\n" + assistant({ id: "m1", usage: { output_tokens: 999 } }) + "\n");
    await s.scan();
    expect(total(s)).toBe(2);
    expect(s.files.get(f)!.recs[0]![4]).toBe(999);

    // A restart: the cache answers, and an unchanged file isn't read (its records stay what was saved).
    const again = new UsageScanner({ roots, cacheFile: cache });
    expect(total(again)).toBe(2);
    await again.scan();
    expect(total(again)).toBe(2);

    // Truncated: read from the start.
    writeFileSync(f, assistant({ id: "m9" }) + "\n");
    await again.scan();
    expect(again.files.get(f)!.recs.length).toBe(1);

    // Replaced by a longer file with different contents (rotation): read from the start, not from the old offset.
    const st2 = statSync(f);
    writeFileSync(f, assistant({ id: "n1", cwd: "/w/b" }) + "\n" + assistant({ id: "n2" }) + "\n");
    utimesSync(f, st2.atime, new Date(st2.mtimeMs + 5000));
    await again.scan();
    expect(again.files.get(f)!.recs.length).toBe(2);
    expect(again.files.get(f)!.project).toBe("/w/b");
  });

  test("subagent files and Codex rollouts are found; other files and old ones aren't read; a deleted file drops out", async () => {
    const p = join(dir, "projects", "-w-a", "s1", "subagents");
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "agent-x.jsonl"), assistant({ id: "a1", sidechain: true }) + "\n");
    writeFileSync(join(p, "agent-x.meta.json"), "{}");
    const c = join(dir, "codex", "2026", "11", "17");
    mkdirSync(c, { recursive: true });
    writeFileSync(join(c, "rollout-1.jsonl"), [meta("t1", "/w/c"), turn("gpt-6-luna"), tokenCount(T, 10, usage(9, 0, 1))].join("\n") + "\n");
    writeFileSync(join(c, "history.jsonl"), assistant({ id: "nope" }) + "\n");
    const old = join(c, "rollout-old.jsonl");
    writeFileSync(old, [meta("t0", "/w/c"), tokenCount(T, 10, usage(9, 0, 1))].join("\n") + "\n");
    utimesSync(old, new Date("2026-01-01"), new Date("2026-01-01"));
    const s = new UsageScanner({ roots });
    await s.scan();
    expect([...s.files.keys()].map((k) => k.slice(dir.length)).sort()).toEqual(["/codex/2026/11/17/rollout-1.jsonl", "/projects/-w-a/s1/subagents/agent-x.jsonl"]);
    expect(s.files.get(join(p, "agent-x.jsonl"))!.session).toBe("s1");
    expect(s.progress).toEqual({ files: 2, done: 2 });
    rmSync(join(c, "rollout-1.jsonl"));
    await s.scan();
    expect(s.files.size).toBe(1);
  });
});
