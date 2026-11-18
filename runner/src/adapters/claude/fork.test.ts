import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

  test("a message that isn't there, or a subagent, leaves nothing", async () => {
    const files = () => readdirSync(join(dir, "projects", "-home-ubuntu--local-share-tether-dev-projects-scratch")).length;
    const n = files();
    await expect(claudeFork.fork({ nativeId: SESSION, projectPath: PROJECT, upTo: "msg_nope", title: "x" })).rejects.toThrow("isn't in the session's store");
    await expect(claudeFork.fork({ nativeId: `${SESSION}/agent-1`, projectPath: PROJECT, title: "x" })).rejects.toThrow("subagent");
    expect(files()).toBe(n);
  });
});
