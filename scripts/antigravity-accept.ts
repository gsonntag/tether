// Acceptance against the real Antigravity (docs/acceptance/ANTIGRAVITY.md): drives `agy` through
// Tether's own session core and terminal control, with a throwaway runner.json and tmux socket.
// Spends a few small turns of the signed-in account.
//
//   bun scripts/antigravity-accept.ts <folder>
//
// <folder> must be one the Antigravity TUI already trusts (run `agy` there once and answer Yes).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { antigravityAdapter } from "../runner/src/adapters/antigravity";
import { saveConfig } from "../runner/src/config";
import { RequestBroker } from "../runner/src/core/broker";
import { EventBus } from "../runner/src/core/bus";
import { LiveControl } from "../runner/src/core/live";
import { Prefs } from "../runner/src/core/prefs";
import { SessionCore } from "../runner/src/core/sessions";
import { TerminalControl } from "../runner/src/terminal/control";
import { Tmux } from "../runner/src/terminal/tmux";

const cwd = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: bun scripts/antigravity-accept.ts <folder>");
const until = async (f: () => boolean, ms = 120_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(100);
  }
};
const check = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) process.exitCode = 1;
};
const show = (ms: { id: string; role: string; parts: any[] }[]) => ms.map((m) => `${m.id}:${m.role}[${m.parts.map((p) => (p.type === "tool" ? `${p.kind}/${p.status}` : p.type)).join(",")}]`).join(" ");
const text = (m: any) => m?.parts.find((p: any) => p.type === "text")?.text ?? "";

const prefsFile = join(mkdtempSync(join(tmpdir(), "tether-agy-accept-")), "runner.json");
saveConfig({ runnerId: "agy-accept" }, prefsFile);
const core = new SessionCore({ adapters: [antigravityAdapter], bus: new EventBus<any>(), send: () => true, epoch: "e1", prefs: new Prefs(prefsFile, 0), evictMs: 60_000, log: () => {} });
const live = new LiveControl(core, new RequestBroker(), { idleMs: 60_000 });
const tmux = new Tmux({ socket: "tether-agy-accept", log: () => {} });
const term = new TerminalControl({ core, live, tmux, send: () => true, buffered: () => 0, hookSocket: null, pollMs: 500, log: () => {} });
await term.start();

try {
  const models = await live.listModels("antigravity");
  check(`models listed (${models.models.map((m) => m.id).join(", ")})`, models.models.length > 1 && models.efforts.length > 0);

  const { sessionId } = await live.newSession({ harness: "antigravity", projectPath: cwd, model: "gemini-3.8-flash", effort: "low" });
  await core.subscribe(sessionId);
  const s = core.sessions.get(sessionId)!;
  const asked: string[] = [];
  const approver = setInterval(() => {
    for (const r of s.state.requests) if (!asked.includes(r.id)) {
      asked.push(r.id);
      void live.answerRequest(sessionId, r.id, { allow: true });
    }
  }, 200);
  const file = `tether-accept-${Date.now()}.txt`;

  await live.send(sessionId, `Create the file ${file} containing the word beta. Then reply done.`);
  await until(() => s.state.status === "idle" && s.transcript!.messages.length >= 2 && !s.state.requests.length);
  check("an approval was asked and answered", asked.length > 0);
  check("the file was written", (await Bun.file(join(cwd, file)).text().catch(() => "")).includes("beta"));
  check(`settings, billing and context (${s.state.model}, ${s.state.effort}, ${s.state.billing?.label})`, s.state.model === "gemini-3.8-flash" && s.state.effort === "low" && !!s.state.billing && !!s.state.context);
  await Bun.sleep(3000);
  check(`the title came from Antigravity ("${s.summary.title}")`, !!s.summary.title && s.summary.title !== "New session");

  const running = live.send(sessionId, "Run the shell command: sleep 5; echo one");
  await Bun.sleep(1500);
  await live.queue.add(sessionId, "Say the word queued-ok.", []);
  check("a message sent while it works waits in the queue", s.state.queue.length === 1);
  await running;
  await until(() => s.state.status === "idle" && !s.state.queue.length && text(s.transcript!.messages.at(-1)).includes("queued"));
  check("the queued message went after the turn", true);

  await live.send(sessionId, "Run the shell command: sleep 60; echo late");
  await Bun.sleep(4000);
  await live.interrupt(sessionId);
  await until(() => s.state.status === "idle");
  check("Stop ends the turn", s.state.status === "idle");
  clearInterval(approver);

  await term.open({ sessionId, attachId: "a1", cols: 120, rows: 35 });
  await until(() => s.state.mode === "terminal", 30_000);
  check("the Terminal hands the session to Antigravity's TUI", s.state.terminal?.kind === "handoff");
  const name = (await tmux.list()).find((t) => t.kind !== "shell")!.name;
  await Bun.sleep(8000);
  const before = s.transcript!.messages.length;
  await tmux.type(name, "Reply with just: from-the-tui");
  await Bun.sleep(300);
  await tmux.keys(name, "Enter");
  await until(() => s.transcript!.messages.length >= before + 2 && text(s.transcript!.messages.at(-1)).includes("from-the-tui"), 90_000);
  check("a turn in the TUI shows in Tether's transcript", true);
  await term.end(sessionId);
  await until(() => s.state.mode !== "terminal", 30_000);
  check("Back to Tether quits the TUI", (await tmux.list()).length === 0);

  await live.send(sessionId, "Reply with just: back-in-tether");
  await until(() => s.state.status === "idle" && text(s.transcript!.messages.at(-1)).includes("back-in-tether"));
  check("Tether drives it again", true);

  const shown = s.transcript!.messages.filter((m) => m.role !== "notice");
  await live.closeAll();
  const stored = await antigravityAdapter.readHistory(s.summary.nativeId, cwd);
  console.log(`live:   ${show(shown)}\nstored: ${show(stored)}`);
  check("the stored transcript has the live one's ids", JSON.stringify(stored.map((m) => m.id)) === JSON.stringify(shown.map((m) => m.id)));
  check("the session is listed in its folder", (await antigravityAdapter.listSessions({ projectPath: cwd })).some((x) => x.nativeId === s.summary.nativeId));
} finally {
  await live.closeAll();
  term.stop();
  core.stop();
  for (const t of await tmux.list().catch(() => [])) await tmux.kill(t.name).catch(() => {});
}
process.exit();
