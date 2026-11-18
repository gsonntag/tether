import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { entriesOf } from "./move";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forkPoints } from "../../../../shared/fork";
import { claudeFork } from "./fork";
import { readHistory } from "./history";
import { keepBilling, keptBilling, windowsIn } from "./context";
import { sessionFile } from "./paths";

const PROJECT = "/home/ubuntu/.local/share/tether-dev/projects/scratch";
const SESSION = "a8d21b1b-b9ed-4f99-a554-acb8bf137c86";
const saved = process.env.CLAUDE_CONFIG_DIR;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tether-fork-"));
  cpSync(join(import.meta.dir, "fixtures", "store"), dir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = dir;
  windowsIn(undefined);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
});

const said = (id: string) => readHistory(id, PROJECT).then((m) => m.filter((x) => x.role !== "notice"));

describe("forking a Claude Code session", () => {
  test("the whole conversation, in a new session file; the original untouched", async () => {
    const before = readFileSync(sessionFile(SESSION, PROJECT)!, "utf8");
    keepBilling(SESSION, { kind: "plan", label: "Claude plan" });
    const id = await claudeFork.fork({ nativeId: SESSION, projectPath: PROJECT, title: "Hello (fork)" });
    expect(id).not.toBe(SESSION);
    const [orig, fork] = [await said(SESSION), await said(id)];
    expect(fork.map((m) => [m.role, m.parts])).toEqual(orig.map((m) => [m.role, m.parts]));
    // Replies keep their ids; the title is the fork's.
    expect(fork.filter((m) => m.role === "assistant").map((m) => m.id)).toEqual(orig.filter((m) => m.role === "assistant").map((m) => m.id));
    expect(readFileSync(sessionFile(id, PROJECT)!, "utf8")).toContain('"customTitle":"Hello (fork)"');
    expect(readFileSync(sessionFile(SESSION, PROJECT)!, "utf8")).toBe(before);
    // Shown as the original's source until its own first start says.
    expect(keptBilling(id)).toEqual({ kind: "plan", label: "Claude plan" });
  });

  test("from a message: the conversation ends at that reply", async () => {
    const orig = await readHistory(SESSION, PROJECT);
    const first = orig.find((m) => forkPoints(orig, false).has(m.id))!;
    const id = await claudeFork.fork({ nativeId: SESSION, projectPath: PROJECT, upTo: first.id, title: "Hello (fork)" });
    const fork = await said(id);
    expect(fork.at(-1)!.id).toBe(first.id);
    const upTo = orig.filter((m) => m.role !== "notice");
    expect(fork.map((m) => m.parts)).toEqual(upTo.slice(0, upTo.findIndex((m) => m.id === first.id) + 1).map((m) => m.parts));
  });

  test("a moved-in session: its imported replies (model <moved>) are fork points the store can end at", async () => {
    const native = "0f0f0f0f-0000-4000-8000-000000000001";
    const items = [
      { role: "user" as const, text: "[From Tether] This session moved here from Codex.", ts: 1 },
      { role: "assistant" as const, text: "Ready.", ts: 2 },
      { role: "user" as const, text: "remember 7", ts: 3 },
      { role: "assistant" as const, text: "ok, 7", ts: 4 },
    ];
    mkdirSync(join(dir, "projects", "-moved"), { recursive: true });
    writeFileSync(join(dir, "projects", "-moved", `${native}.jsonl`), `${entriesOf({ nativeId: native, projectPath: "/moved", items }).join("\n")}\n`);
    const orig = await readHistory(native, "/moved");
    const points = orig.filter((m) => forkPoints(orig, false).has(m.id));
    expect(points.map((m) => (m.parts[0] as any).text)).toEqual(["Ready.", "ok, 7"]);
    const id = await claudeFork.fork({ nativeId: native, projectPath: "/moved", upTo: points[0]!.id, title: "Moved (fork)" });
    const fork = (await readHistory(id, "/moved")).filter((m) => m.role !== "notice");
    expect(fork.map((m) => (m.parts[0] as any).text)).toEqual([(orig[0]!.parts[0] as any).text, "Ready."]);
  });

  test("across a compaction (recorded): from a reply before it and one after, each ends where asked", async () => {
    // The recorded file under a real UUID: the SDK takes only those.
    const native = "c0ffee7e-0000-4000-8000-000000000001";
    cpSync(join(dir, "projects", "-compacted", "c0mpac7e-0000-4000-8000-000000000001.jsonl"), join(dir, "projects", "-compacted", `${native}.jsonl`));
    const orig = await readHistory(native, "/compacted");
    const ids = orig.filter((m) => forkPoints(orig, false).has(m.id)).map((m) => m.id);
    const compaction = orig.findIndex((m) => m.role === "notice" && (m.parts[0] as any)?.text === "Context compacted.");
    expect(compaction).toBeGreaterThan(0);
    const before = ids.filter((id) => orig.findIndex((m) => m.id === id) < compaction).at(-1)!;
    const after = ids.filter((id) => orig.findIndex((m) => m.id === id) > compaction)[0]!;
    for (const upTo of [before, after]) {
      const id = await claudeFork.fork({ nativeId: native, projectPath: "/compacted", upTo, title: "C (fork)" });
      expect((await readHistory(id, "/compacted")).filter((m) => m.role !== "notice").at(-1)!.id).toBe(upTo);
    }
  });

  test("discard removes a fork's file", async () => {
    const id = await claudeFork.fork({ nativeId: SESSION, projectPath: PROJECT, title: "x" });
    expect(sessionFile(id, PROJECT)).toBeDefined();
    await claudeFork.discard!(id, PROJECT);
    expect(sessionFile(id, PROJECT)).toBeUndefined();
  });

  test("a message that isn't there, or a subagent, leaves nothing", async () => {
    const files = () => readdirSync(join(dir, "projects", "-home-ubuntu--local-share-tether-dev-projects-scratch")).length;
    const n = files();
    await expect(claudeFork.fork({ nativeId: SESSION, projectPath: PROJECT, upTo: "msg_nope", title: "x" })).rejects.toThrow("isn't in the session's store");
    await expect(claudeFork.fork({ nativeId: `${SESSION}/agent-1`, projectPath: PROJECT, title: "x" })).rejects.toThrow("subagent");
    expect(files()).toBe(n);
  });
});
