// The reports the runner really sends the Home agent read as the Home chat's one-line summaries
// (shared/homeReport.ts): if a report's wording changes, this fails before the chat shows walls of text.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeReport } from "../../../../shared/homeReport";
import type { Adapter, AgentSetup } from "../../core/adapter";
import { askQuestion, FakeAdapter, idle, say } from "../../core/fakeAdapter";
import { createRunner } from "../../core/runner";
import { CredentialStore } from "../../credentials";
import { homeAgentModule, WATCH } from ".";

const stops: (() => void)[] = [];
const WATCH_DEFAULT = { ...WATCH };
afterEach(() => {
  stops.splice(0).forEach((f) => f());
  Object.assign(WATCH, WATCH_DEFAULT);
});

async function until(f: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tether-home-report-"));
  stops.push(() => rmSync(dir, { recursive: true, force: true }));
  const homeFolder = join(dir, "home");
  const project = join(dir, "project");
  mkdirSync(homeFolder);
  mkdirSync(project);
  mkdirSync(join(dir, "data"));
  const fake = new FakeAdapter();
  const setups = new Map<string, (nativeId: string) => AgentSetup>();
  (fake as Adapter).agentSetup = (folder, make) => (setups.set(folder, make), () => void setups.delete(folder));
  const credentials = new CredentialStore(join(dir, "credentials.json"));
  const runner = createRunner({ url: "http://x", token: "t", runnerId: "t", name: "t", version: "0", detectHarnesses: async () => [], adapters: [fake], prefsFile: join(dir, "runner.json"), homeFolder, core: { evictMs: 60_000 }, credentials });
  stops.push(() => runner.core.stop());
  const stop = await homeAgentModule.start({ bus: runner.bus, ops: runner.ops, dataDir: join(dir, "data"), log: () => {}, runnerId: "t", appUrl: "http://x", ...runner.look, announceHomeChat: () => {} } as any);
  if (stop) stops.push(stop);
  const op = async (name: string, args: unknown = {}): Promise<any> => {
    const r = await runner.ops.handle(name, args);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };
  const chat = (await op("homeAgentNew")).sessionId as string;
  const tools = (sessionId: string) => Object.fromEntries(setups.get(homeFolder)!(sessionId.split(":")[1]!).tools.map((t) => [t.name, t.run]));
  const driverOf = (id: string) => fake.drivers.find((d) => `claude:${d.nativeId}` === id);
  return { runner, fake, op, chat, tools, driverOf, project };
}

test("a started session's turn report and its wait for the person", async () => {
  const { runner, fake, chat, tools, driverOf, project } = await setup();
  fake.script = (text) => (text.includes("ASK") ? [askQuestion("Which color?", ["red", "blue"])] : [say("a1", "Merged it.\nMore detail."), idle]);
  const said = await tools(chat).start_session!({ project_path: project, prompt: "Go.", title: "Fix tests" });
  const child = /session (\S+) in/.exec(said)![1]!;
  await until(() => driverOf(chat)?.sent.length === 1);
  expect(homeReport(driverOf(chat)!.sent[0]!)).toEqual({ kind: "turn", summary: "Report from “Fix tests” (project): finished a turn · 1 of 12", attention: false });
  await until(() => runner.core.sessions.get(chat)?.state.status === "idle");
  await tools(chat).send_to_session!({ session_id: child, message: "ASK" });
  await until(() => driverOf(chat)!.sent.length === 2);
  expect(homeReport(driverOf(chat)!.sent[1]!)).toEqual({ kind: "waiting", summary: "“Fix tests” (project) is waiting for you: Which color?", attention: true });
});

test("a watch report", async () => {
  WATCH.quietMs = 100;
  const { fake, op, chat, driverOf, project } = await setup();
  fake.script = (text) => (text.startsWith("BOOM") ? [(s) => s.state({ status: "idle", error: "it broke" })] : [say(`a-${text}`, `did ${text}`), idle]);
  const make = async (title: string) => {
    const id = (await op("newSession", { harness: "claude", projectPath: project })).sessionId as string;
    await op("renameSession", { sessionId: id, title });
    return id;
  };
  const a = await make("task a");
  const b = await make("task b");
  await op("send", { sessionId: a, text: "work a" });
  await op("send", { sessionId: b, text: "BOOM" }).catch(() => {});
  await until(() => driverOf(chat)?.sent.length === 1);
  expect(homeReport(driverOf(chat)!.sent[0]!)).toEqual({ kind: "watch", summary: "2 sessions you didn't start updated · 1 failed", attention: true });
});
