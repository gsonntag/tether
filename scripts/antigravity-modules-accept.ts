// Acceptance for Antigravity's subagents, plan review, fork, side chats, move and Tether's tools
// (docs/acceptance/ANTIGRAVITY.md), against the real `agy`: the real runner (runner/src/index.ts,
// every module) with a throwaway config dir, data dir and tmux socket, behind a stand-in relay that
// calls its ops the way the app does. Spends a few small turns of the signed-in Google account, and
// one Claude Haiku turn for the move.
//
//   bun scripts/antigravity-modules-accept.ts [--only subagent,plan,fork,side,move,peers]

import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Msg, SessionSnapshot } from "../shared/transcript";

const only = process.argv.includes("--only") ? new Set(process.argv[process.argv.indexOf("--only") + 1]!.split(",")) : undefined;
const want = (k: string) => !only || only.has(k);
const root = mkdtempSync(join(tmpdir(), "tether-agy-e2e-"));
const folder = join(root, "project");
mkdirSync(folder);
writeFileSync(join(folder, "notes.txt"), "line one\nline two\n");
Bun.spawnSync(["git", "init", "-q"], { cwd: folder });

let failed = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const until = async (f: () => Promise<boolean> | boolean, ms = 180_000, every = 1000) => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(every);
  }
};

// ---------- the stand-in relay ----------

let sock: any;
let nextId = 0;
const pending = new Map<string, { ok: (v: any) => void; fail: (e: Error) => void }>();
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 })),
  websocket: {
    open(ws) {
      sock = ws;
    },
    message(ws, raw) {
      const m = JSON.parse(String(raw));
      if (m.t === "hello") ws.send(JSON.stringify({ t: "welcome" }));
      else if (m.t === "result") {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.ok) p?.ok(m.data);
        else p?.fail(new Error(m.error));
      }
    },
  },
});
const rpc = <T = any>(op: string, args: unknown): Promise<T> =>
  new Promise((ok, fail) => {
    const id = `r${++nextId}`;
    pending.set(id, { ok, fail });
    sock.send(JSON.stringify({ t: "rpc", id, op, args }));
  });

// ---------- the runner ----------

const config = join(root, "config");
mkdirSync(config, { recursive: true });
writeFileSync(join(config, "runner.json"), JSON.stringify({ runnerId: "agy-e2e", name: "agy-e2e" }));
const runner = Bun.spawn([process.execPath, "src/index.ts"], {
  cwd: resolve(import.meta.dir, "../runner"),
  env: { ...process.env, TETHER_URL: `http://127.0.0.1:${server.port}`, TETHER_TOKEN: "e2e", TETHER_CONFIG_DIR: config, TETHER_DATA_DIR: join(root, "data"), TETHER_TMUX_SOCKET: "tether-agy-e2e", TETHER_IDLE_MS: "600000" },
  stdout: Bun.file(join(root, "runner.log")),
  stderr: Bun.file(join(root, "runner.err")),
});
console.log(`runner log: ${join(root, "runner.log")}`);

const snap = (id: string) => rpc<SessionSnapshot>("subscribe", { sessionId: id, limit: 200 });
const text = (m?: Msg) => (m?.parts ?? []).filter((p) => p.type === "text").map((p: any) => p.text).join("");
const lastText = async (id: string) => text((await snap(id)).messages.filter((m) => m.role === "assistant").at(-1));
/** What each session asked a person, by tool (and path), as the approver saw it. */
const asked = new Map<string, string[]>();
/** Approves every approval in these sessions until stopped (a plan is left for the test). */
const approver = (ids: () => string[]) => {
  const done = new Set<string>();
  const t = setInterval(async () => {
    for (const id of ids()) {
      const s = await snap(id).catch(() => undefined);
      for (const r of s?.state.requests ?? []) {
        if (done.has(r.id) || r.plan !== undefined || r.kind !== "approval") continue;
        done.add(r.id);
        asked.set(id, [...(asked.get(id) ?? []), `${r.tool ?? ""} ${r.path ?? r.command ?? ""}`]);
        await rpc("answerRequest", { sessionId: id, requestId: r.id, allow: true }).catch(() => {});
      }
    }
  }, 700);
  return () => clearInterval(t);
};
const idle = async (id: string) => {
  const s = await snap(id);
  return s.state.status === "idle" && !s.state.requests.length && !s.state.queue.length && !s.state.backgroundSubagents;
};
const newSession = async (mode = "default") => (await rpc<{ sessionId: string }>("newSession", { harness: "antigravity", projectPath: folder, model: "gemini-3.8-flash", effort: "low", permissionMode: mode })).sessionId;

try {
  await until(() => !!sock, 30_000, 200);
  await until(async () => (await rpc<any>("ping", {}).catch(() => null)) !== null, 30_000, 500);
  const live: string[] = [];
  const stopApproving = approver(() => live);

  if (want("peers")) {
    const id = await newSession("default");
    live.push(id);
    await rpc("send", { sessionId: id, text: "Call the tether_sessions tool from the tether MCP server once, then reply with just the number of sessions it listed." });
    await until(() => idle(id));
    const s = await snap(id);
    const peer = s.messages.flatMap((m) => m.parts).find((p: any) => p.type === "tool" && p.kind === "peer") as any;
    check("Tether's tools: the agent called tether_sessions", !!peer, peer?.name);
    check("…and it ran without asking anyone", peer?.status === "done" && !(asked.get(id) ?? []).some((a) => a.startsWith("mcp_tether")), `${peer?.status}; asked: ${(asked.get(id) ?? []).join(", ") || "nothing"}`);
  }

  let main = "";
  if (want("fork") || want("side") || want("move")) {
    main = await newSession("default");
    live.push(main);
    await rpc("send", { sessionId: main, text: "Reply with just: alpha" });
    await until(() => idle(main));
    await rpc("send", { sessionId: main, text: "Reply with just: beta" });
    await until(() => idle(main));
    check("two turns for fork, side chat and move", (await snap(main)).messages.filter((m) => m.role === "user").length === 2);
  }

  if (want("fork")) {
    const first = (await snap(main)).messages.find((m) => m.role === "assistant")!;
    const { sessionId: fork } = await rpc<{ sessionId: string }>("forkSession", { sessionId: main, messageId: first.id });
    live.push(fork);
    const fs = await snap(fork);
    check("Fork from here: the fork has the conversation up to that reply", fs.messages.filter((m) => m.role !== "notice").length === 2, `${fs.messages.length} messages`);
    check("…and says where it came from", !!fs.session.forkedFrom && fs.messages.some((m) => m.role === "notice"));
    await rpc("send", { sessionId: fork, text: "Without tools: list every message I sent you in this conversation, verbatim, one per line." });
    await until(() => idle(fork));
    const said = await lastText(fork);
    check("…and continues knowing only the kept turn", said.includes("alpha") && !said.includes("beta"), said.slice(0, 120).replace(/\n/g, " | "));
    const orig = await snap(main);
    check("the original is unchanged", orig.messages.filter((m) => m.role === "user").length === 2);
    const { sessionId: whole } = await rpc<{ sessionId: string }>("forkSession", { sessionId: main });
    check("Fork: a whole fork has both turns", (await snap(whole)).messages.filter((m) => m.role === "user").length === 2);
  }

  if (want("side")) {
    const { sessionId: side } = await rpc<{ sessionId: string }>("openSideChat", { sessionId: main, question: "What was the second word you replied with?" });
    await until(() => idle(side));
    const s = await snap(side);
    check("Side chat: it answers from the conversation", (await lastText(side)).toLowerCase().includes("beta"), (await lastText(side)).slice(0, 80));
    check("…in Antigravity's default mode", s.state.permissionMode === "default", s.state.permissionMode);
    await rpc("send", { sessionId: side, text: "Create the file side-test.txt containing x, using write_to_file. Do it now." });
    await until(() => idle(side));
    check("…and a write is refused without asking anyone", !existsSync(join(folder, "side-test.txt")));
    const back = await rpc<{ text: string }>("bringBack", { sessionId: side });
    check("…Bring back returns its summary", back.text.startsWith("From a side chat"), back.text.slice(0, 80).replace(/\n/g, " "));
    await rpc("closeSideChat", { sessionId: side });
  }

  if (want("plan")) {
    const id = await newSession("plan");
    live.push(id);
    await rpc("send", { sessionId: id, text: "Plan adding a file hello.txt containing the word hello. Write the plan for my review; don't create the file yet." });
    await until(async () => (await snap(id)).state.requests.some((r) => r.plan !== undefined) || (await idle(id)));
    const plan = (await snap(id)).state.requests.find((r) => r.plan !== undefined);
    check("Plan review: a plan mode turn ends on a plan to review", !!plan?.plan?.trim(), plan?.plan?.slice(0, 60).replace(/\n/g, " "));
    if (plan) {
      await rpc("answerRequest", { sessionId: id, requestId: plan.id, allow: true });
      await until(async () => existsSync(join(folder, "hello.txt")) && (await idle(id)));
      check("…approving leaves plan mode and it's carried out", readFileSync(join(folder, "hello.txt"), "utf8").includes("hello"), (await snap(id)).state.permissionMode);
    }
  }

  if (want("subagent")) {
    const id = await newSession("accept-edits");
    live.push(id);
    await rpc("send", { sessionId: id, text: "Use the invoke_subagent tool (TypeName self) to start one subagent whose task is: read notes.txt with read_file and report its contents to you with send_message. Then wait for its report and tell me what it found." });
    await until(async () => (await rpc<any>("listSessions", { parentSessionId: id })).sessions.length > 0, 120_000);
    const kid = (await rpc<any>("listSessions", { parentSessionId: id })).sessions[0];
    live.push(kid.id);
    check("Subagents: the subagent shows as a child session", !!kid?.parentSessionId, kid?.title);
    await until(async () => (await snap(kid.id)).messages.some((m) => m.parts.some((p: any) => p.type === "tool" && p.kind === "read")), 120_000);
    const ks = await snap(kid.id);
    check("…its transcript shows its prompt and its read", ks.messages[0]?.role === "user" && ks.messages.length >= 2);
    const card = (await snap(id)).messages.flatMap((m) => m.parts).find((p: any) => p.type === "tool" && p.name === "invoke_subagent") as any;
    check("…the parent's call links to it", card?.childSessionId === kid.id);
    await until(async () => (await lastText(id)).includes("line one") && (await idle(id)), 240_000, 2000);
    check("…its report reaches the parent, which goes on by itself", true);
  }

  if (want("move")) {
    const { sessionId: claude } = await rpc<{ sessionId: string }>("moveSession", { sessionId: main, harness: "claude", model: "claude-haiku-4-5" });
    live.push(claude);
    await until(() => idle(claude));
    check("Move out: an Antigravity session moves to Claude Code", (await snap(claude)).messages.some((m) => m.role === "notice"));
    const { sessionId: back } = await rpc<{ sessionId: string }>("moveSession", { sessionId: claude, harness: "antigravity", model: "gemini-3.8-flash", effort: "low" });
    live.push(back);
    await until(() => idle(back));
    const bs = await snap(back);
    check("Move in: Antigravity takes the context route and replies", bs.session.harness === "antigravity" && bs.messages.some((m) => m.role === "assistant"), (await lastText(back)).slice(0, 60));
    await rpc("send", { sessionId: back, text: "Use read_file on the moved history file you were told about (history.md), then reply with just the first word the assistant replied with in it." });
    await until(() => idle(back));
    const read = (await snap(back)).messages.flatMap((m) => m.parts).find((p: any) => p.type === "tool" && p.kind === "read" && String(p.path ?? "").includes("/modules/move/")) as any;
    const askedRead = (asked.get(back) ?? []).filter((a) => a.includes("/modules/move/"));
    check("…and reads its moved history without asking anyone", read?.status === "done" && !askedRead.length, `${read?.path ?? "no read"} ${read?.status ?? ""}; asked: ${askedRead.join(", ") || "nothing"}`);
  }
  stopApproving();
} catch (e: any) {
  check(`no error (${e?.message ?? e})`, false);
} finally {
  runner.kill();
  await runner.exited;
  Bun.spawnSync(["tmux", "-L", "tether-agy-e2e", "kill-server"]);
  server.stop(true);
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
