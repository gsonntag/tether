// A fake runner for looking at the web UI without a real harness: canned projects and sessions
// (every tool kind, markdown, thinking, notices, a subagent, a 300-message session to page), and a
// scripted streamed reply to every `send`. Dials a dev server like the real runner does.
//   TETHER_URL=http://127.0.0.1:8791 bun scripts/fake-runner.ts [runnerId]

import { Connection } from "../runner/src/core/connection";
import { newestPage, partChunk } from "../shared/limits";
import { PROTOCOL_VERSION, type SummaryUpdate } from "../shared/protocol";
import type { HarnessCapabilities, LiveState, ModelList, Msg, Part, SessionEvent, SessionSummary, ToolPart } from "../shared/transcript";

const url = process.env.TETHER_URL ?? "http://127.0.0.1:8791";
const runnerId = process.argv[2] ?? "fake";
const epoch = crypto.randomUUID();
let summarySeq = 0;
const now = Date.now();
const caps: HarnessCapabilities = { canSteer: true, terminal: "handoff", subagents: { view: true, stop: true, steer: false } };

interface Sess {
  summary: SessionSummary;
  messages: Msg[];
  state: LiveState;
  seq: number;
  timers: ReturnType<typeof setTimeout>[];
}
const sessions = new Map<string, Sess>();
let n = 0;
const id = (p: string) => `${p}${++n}`;

function add(summary: Partial<SessionSummary> & { id: string; title: string; projectPath: string }, messages: Msg[], state: Partial<LiveState> = {}) {
  const s: Sess = {
    summary: { harness: "claude", nativeId: summary.id.slice(7), mode: "stored", status: "idle", updatedAt: now, ...summary },
    messages,
    state: { mode: "stored", status: "idle", model: "haiku", modelResolved: "claude-haiku-5-5", effort: "high", permissionMode: "acceptEdits", requests: [], queue: [], ...state },
    seq: 0,
    timers: [],
  };
  sessions.set(s.summary.id, s);
  return s;
}

const user = (text: string, ts = now): Msg => ({ id: id("u"), role: "user", ts, parts: [{ type: "text", text }] });
const asst = (parts: Part[], ts = now): Msg => ({ id: id("a"), role: "assistant", ts, model: "claude-haiku-5-5", parts });
const tool = (name: string, kind: ToolPart["kind"], input: any, output?: string, extra: Partial<ToolPart> = {}): ToolPart => ({
  type: "tool",
  id: id("toolu_"),
  name,
  kind,
  input,
  status: "done",
  output,
  ...(kind === "shell" ? { command: input.command } : {}),
  ...(input.file_path ? { path: input.file_path } : {}),
  ...extra,
});

const P = "/home/me/code/web";
const bigOutput = Array.from({ length: 4000 }, (_, i) => `${String(i + 1).padStart(6)}→ const line${i} = "${"x".repeat(40)}";`).join("\n");

// ---------- canned sessions ----------

const showcaseId = "claude:show-1";
const childId = `claude:show-1/a1b2c3`;
add({ id: showcaseId, title: "Showcase: every kind of tool card, markdown and a subagent", projectPath: P, updatedAt: now - 60_000 }, [
  user("Fix the login bug and tell me what you changed. Also count the lines in the repo with a subagent."),
  asst([
    { type: "thinking", text: "The user wants the login bug fixed. Let me look at auth.ts first, then run the tests." },
    { type: "text", text: "I'll start by looking at **auth.ts** and the tests.\n\n- read the file\n- find the bug\n- fix it\n\n```ts\nexport function login(user: string) {\n  return check(user);\n}\n```" },
    tool("Read", "read", { file_path: `${P}/src/auth.ts` }, bigOutput, { truncated: 0 }),
    tool("Grep", "search", { pattern: "session\\.expires", path: `${P}/src` }, "src/auth.ts:12\nsrc/session.ts:40"),
    tool("Glob", "search", { pattern: "**/*.test.ts" }, "src/auth.test.ts\nsrc/session.test.ts"),
    tool("Bash", "shell", { command: "bun test src/auth.test.ts", description: "Run the auth tests" }, "bun test v1.4.2\n\nsrc/auth.test.ts:\n✗ login keeps the session [3.1ms]\n\n 0 pass\n 1 fail", { status: "error" }),
    tool("Edit", "edit", { file_path: `${P}/src/auth.ts`, old_string: "export function login(user: string) {\n  if (expired(session)) return null;\n  return check(user);\n}", new_string: "export function login(user: string) {\n  if (expired(session)) refresh(session);\n  return check(user);\n}" }, "The file was updated."),
    tool("Write", "write", { file_path: `${P}/src/refresh.ts`, content: "export function refresh(s: Session) {\n  s.expires = Date.now() + 3600_000;\n}\n" }, "File created."),
    tool("WebFetch", "fetch", { url: "https://example.com/docs/sessions", prompt: "How long do sessions last?" }, "Sessions last one hour by default."),
    tool("TodoWrite", "todo", { todos: [{ content: "Read auth.ts", status: "completed", activeForm: "Reading auth.ts" }, { content: "Fix the expiry check", status: "in_progress", activeForm: "Fixing the expiry check" }, { content: "Run the tests", status: "pending", activeForm: "Running the tests" }] }),
    tool("Agent", "task", { description: "Count lines in the repo", prompt: "Run wc -l on every source file and report the total.", subagent_type: "general-purpose" }, "There are 1,284 lines across 23 files.", { childSessionId: childId }),
    tool("mcp__github__create_issue", "other", { repo: "me/web", title: "Session expiry", labels: ["bug"] }, "Created issue #42"),
  ]),
  { id: id("n"), role: "notice", level: "warning", ts: now, parts: [{ type: "text", text: "Claude asked to run `rm -rf build` — denied: approvals aren't available in Tether yet. Switch the mode to Bypass permissions to let it act." }] },
  { id: id("n"), role: "notice", level: "info", ts: now, parts: [{ type: "text", text: "Interrupted" }] },
  asst([{ type: "text", text: "The bug was in `login`: an expired session returned `null` instead of being refreshed. I changed it to refresh the session.\n\n| File | Change |\n|---|---|\n| src/auth.ts | refresh instead of failing |\n| src/refresh.ts | new |" }]),
]);
add({ id: childId, title: "Count lines in the repo", projectPath: P, parentSessionId: showcaseId, parentToolId: "x", agentType: "general-purpose", updatedAt: now - 50_000 }, [
  user("Run wc -l on every source file and report the total."),
  asst([{ type: "thinking", text: "" }, tool("Bash", "shell", { command: "wc -l src/*.ts | tail -1" }, "  1284 total")]),
  asst([{ type: "text", text: "There are **1,284** lines across 23 files." }]),
]);

const long: Msg[] = [];
for (let i = 0; i < 150; i++) {
  long.push(user(`Question ${i + 1}: what about item ${i + 1}?`, now - (300 - i) * 60_000));
  long.push(asst([{ type: "text", text: `Answer ${i + 1}. ${"Some longer explanation of the point. ".repeat(1 + (i % 7))}` }, ...(i % 5 === 0 ? [tool("Bash", "shell", { command: `echo ${i}` }, `${i}`)] : [])], now - (300 - i) * 60_000));
}
add({ id: "claude:long-1", title: "Long session (300 messages)", projectPath: P, updatedAt: now - 3_600_000 }, long);
// For scroll checks (scripts/scroll-jank.mjs): 240 messages of very different heights, from a line
// to several screens: long markdown, code blocks, tool cards with output and diffs.
const words = "the session keeps its place while older pages arrive and rows are measured as they mount".split(" ");
const prose = (i: number, n: number) => Array.from({ length: n }, (_, k) => words[(i * 7 + k) % words.length]).join(" ");
const code = (i: number, lines: number) => "```ts\n" + Array.from({ length: lines }, (_, k) => `export const v${i}_${k} = compute(${k}, "${"y".repeat(k % 30)}");`).join("\n") + "\n```";
const mixed: Msg[] = [];
for (let i = 0; i < 120; i++) {
  const t = now - (240 - i) * 60_000;
  mixed.push(user(i % 9 === 0 ? `Q${i + 1}. ${prose(i, 120)}` : `Q${i + 1}. ${prose(i, 8 + (i % 13))}`, t));
  const parts: Part[] = [{ type: "text", text: `A${i + 1}. ${prose(i, 30 + ((i * 37) % 400))}\n\n${i % 3 === 0 ? code(i, 5 + ((i * 11) % 50)) : "- one\n- two\n- three"}\n\n${prose(i + 1, (i * 13) % 200)}` }];
  if (i % 4 === 1) parts.push(tool("Bash", "shell", { command: `grep -rn item${i} src` }, Array.from({ length: 30 + (i % 40) }, (_, k) => `src/f${k}.ts:${k}: item${i}`).join("\n")));
  if (i % 6 === 2) parts.push(tool("Edit", "edit", { file_path: `${P}/src/m${i}.ts`, old_string: "a\nb\nc\nd", new_string: "a\nB\nc\nD\ne" }, "The file was updated."));
  if (i % 5 === 3) parts.push(tool("Read", "read", { file_path: `${P}/src/r${i}.ts` }, "1\tline\n2\tline"));
  mixed.push(asst(parts, t));
}
add({ id: "claude:scroll-1", title: "Scroll fixture (240 mixed messages)", projectPath: P, updatedAt: now - 30_000 }, mixed);
// A huge session for memory and paging checks, with HUGE=<pairs> (1500 makes 3000 messages): big
// tool cards, diffs, and an image every 25 prompts.
const HUGE = Number(process.env.HUGE ?? 0);
if (HUGE > 0) {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#4a8"/><text x="20" y="200" font-size="40">img</text></svg>').toString("base64");
  const huge: Msg[] = [];
  for (let i = 0; i < HUGE; i++) {
    const t = now - (2 * HUGE - i) * 60_000;
    huge.push(i % 25 === 7 ? { ...user(`Q${i + 1} with an image`, t), parts: [{ type: "text", text: `Q${i + 1} with an image` }, { type: "image", mimeType: "image/svg+xml", data: svg }] } : user(`Q${i + 1}. ${prose(i, 8 + (i % 13))}`, t));
    const parts: Part[] = [{ type: "text", text: `A${i + 1}. ${prose(i, 30 + ((i * 37) % 400))}\n\n${i % 3 === 0 ? code(i, 5 + ((i * 11) % 50)) : "- one\n- two"}` }];
    if (i % 2 === 1) parts.push(tool("Bash", "shell", { command: `grep -rn item${i} src` }, Array.from({ length: 60 + (i % 80) }, (_, k) => `src/f${k}.ts:${k}: item${i} ${"z".repeat(k % 50)}`).join("\n")));
    if (i % 3 === 2) parts.push(tool("Edit", "edit", { file_path: `${P}/src/m${i}.ts`, old_string: Array.from({ length: 40 }, (_, k) => `old line ${k}`).join("\n"), new_string: Array.from({ length: 45 }, (_, k) => `new line ${k} ${k % 3 ? "same" : "changed"}`).join("\n") }, "The file was updated."));
    if (i % 5 === 3) parts.push(tool("Read", "read", { file_path: `${P}/src/r${i}.ts` }, Array.from({ length: 200 }, (_, k) => `${k}\tline ${k}`).join("\n")));
    huge.push(asst(parts, t));
  }
  add({ id: "claude:huge-1", title: `Huge fixture (${2 * HUGE} messages)`, projectPath: P, updatedAt: now - 20_000 }, huge);
}
// An ordinary chat of short rows, with SHORT=<pairs> (1000 makes 2000 rows of about 130 px): a
// fling crosses many rows, so the window's overshoot and trims show (scroll-jank.mjs).
if (process.env.SHORT) {
  const short: Msg[] = [];
  const pairs = Number(process.env.SHORT);
  for (let i = 0; i < pairs; i++) {
    const t = now - (2 * pairs - i) * 60_000;
    short.push(user(`Q${i + 1}. ${prose(i, 6 + (i % 7))}`, t));
    short.push(asst([{ type: "text", text: `A${i + 1}. ${prose(i, 20 + (i % 30))}` }], t));
  }
  add({ id: "claude:shortchat-1", title: `Short rows (${2 * pairs})`, projectPath: P, updatedAt: now - 10_000 }, short);
}
add({ id: "claude:short-1", title: "Rename the settings page", projectPath: "/home/me/code/api", updatedAt: now - 2 * 86_400_000 }, [user("Rename the settings page to Preferences."), asst([{ type: "text", text: "Done: renamed in 3 files." }])]);
add({ id: "claude:empty-1", title: "A session with a very long title that must be cut with an ellipsis on a phone screen", projectPath: "/home/me/scratch", updatedAt: now - 20 * 86_400_000 }, []);

// ---------- wire ----------

const conn = new Connection({
  url,
  token: "dev",
  hello: async () => ({ id: runnerId, name: runnerId, hostname: "fakehost", version: "0.0.0", protocol: PROTOCOL_VERSION, harnesses: [{ id: "claude", version: "2.1.312" }] }),
  onRpc: async (op, args) => {
    try {
      return { ok: true, data: await handle(op, args as any) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  onState: (c) => c && summary({ kind: "all", epoch, seq: summarySeq, sessions: summaries() }),
});

const summaries = () => [...sessions.values()].map((s) => s.summary);
function summary(u: SummaryUpdate) {
  conn.send({ t: "summary", summary: u });
}
function upsert(s: Sess) {
  s.summary = { ...s.summary, updatedAt: Date.now(), status: s.state.status, mode: s.state.mode };
  summary({ kind: "upsert", epoch, seq: ++summarySeq, sessions: [s.summary] });
}
function emit(s: Sess, event: SessionEvent) {
  // Apply to our copy (as the real core does), then send.
  if (event.type === "msg") {
    const i = s.messages.findIndex((m) => m.id === event.msg.id);
    if (i >= 0) s.messages[i] = event.msg;
    else s.messages.push(event.msg);
  } else if (event.type === "delta") {
    const m = s.messages.find((x) => x.id === event.msgId)!;
    const p = m.parts[event.part] as { text: string };
    p.text += event.text;
  } else if (event.type === "tool") {
    const m = s.messages.find((x) => x.id === event.msgId)!;
    m.parts = m.parts.map((p) => (p.type === "tool" && p.id === event.toolId ? { ...p, ...event.patch } : p));
  } else if (event.type === "state") {
    s.state = { ...s.state, ...event.state };
  }
  conn.send({ t: "event", sessionId: s.summary.id, seq: ++s.seq, event });
}
const get = (sid: string) => {
  const s = sessions.get(sid);
  if (!s) throw new Error("No such session.");
  return s;
};
const MODELS: ModelList = {
  models: [
    { id: "default", label: "Default (recommended)", resolved: "claude-opus-5-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "opus", label: "Opus 5.5", resolved: "claude-opus-5-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "sonnet", label: "Sonnet 5.5", resolved: "claude-sonnet-5-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "haiku", label: "Haiku 5.5", resolved: "claude-haiku-5-5", efforts: ["low", "medium", "high"] },
  ],
  efforts: ["low", "medium", "high", "xhigh", "max"].map((e) => ({ id: e, label: { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" }[e]! })),
  permissionModes: [
    { id: "default", label: "Ask first" },
    { id: "acceptEdits", label: "Accept edits" },
    { id: "plan", label: "Plan" },
    { id: "bypassPermissions", label: "Bypass permissions" },
  ],
};

async function handle(op: string, a: any): Promise<unknown> {
  switch (op) {
    case "ping":
      return { runnerId, at: Date.now() };
    case "listProjects": {
      const by = new Map<string, { path: string; name: string; harnesses: ["claude"]; updatedAt: number; sessions: number }>();
      for (const s of sessions.values()) {
        if (s.summary.parentSessionId) continue;
        const p = by.get(s.summary.projectPath) ?? { path: s.summary.projectPath, name: s.summary.projectPath.split("/").pop()!, harnesses: ["claude"], updatedAt: 0, sessions: 0 };
        p.sessions++;
        p.updatedAt = Math.max(p.updatedAt, s.summary.updatedAt);
        by.set(p.path, p);
      }
      return { projects: [...by.values()].sort((x, y) => y.updatedAt - x.updatedAt) };
    }
    case "listSessions": {
      let list = summaries();
      if (a.parentSessionId) list = list.filter((s) => s.parentSessionId === a.parentSessionId);
      if (a.projectPath) list = list.filter((s) => s.projectPath === a.projectPath && !s.parentSessionId);
      if (a.query) list = list.filter((s) => s.title.toLowerCase().includes(String(a.query).toLowerCase()));
      list.sort((x, y) => y.updatedAt - x.updatedAt);
      return a.parentSessionId || a.projectPath || a.query ? { sessions: list } : { sessions: list, epoch, seq: summarySeq };
    }
    case "subscribe": {
      const s = get(a.sessionId);
      const page = newestPage(s.messages, a.limit ?? 50);
      return { session: s.summary, capabilities: caps, messages: page.messages, hasOlder: page.hasOlder, state: s.state, seq: s.seq };
    }
    case "history": {
      const s = get(a.sessionId);
      const i = s.messages.findIndex((m) => m.id === a.before);
      if (i < 0) throw new Error("That message is gone.");
      await Bun.sleep(300);
      return newestPage(s.messages.slice(0, i), a.limit ?? 50);
    }
    case "fullPart": {
      const m = get(a.sessionId).messages.find((x) => x.id === a.msgId);
      const part = m?.parts[a.part];
      if (!part) throw new Error("No such part.");
      return partChunk(part, a.offset);
    }
    case "listModels":
      await Bun.sleep(200);
      return MODELS;
    case "newSession": {
      if (!String(a.projectPath).startsWith("/") && !String(a.projectPath).startsWith("~")) throw new Error(`No such folder: ${a.projectPath}`);
      const s = add({ id: `claude:${crypto.randomUUID()}`, title: "New session", projectPath: a.projectPath, updatedAt: Date.now() }, [], { mode: "live", model: a.model ?? "default", permissionMode: a.permissionMode ?? "default" });
      upsert(s);
      return { sessionId: s.summary.id };
    }
    case "send":
      return send(get(a.sessionId), a.text);
    case "interrupt": {
      const s = get(a.sessionId);
      s.timers.splice(0).forEach(clearTimeout);
      const last = s.messages.at(-1);
      if (last?.streaming) emit(s, { type: "msg", msg: { ...last, streaming: false } });
      emit(s, { type: "msg", isNew: true, msg: { id: id("n"), role: "notice", level: "info", ts: Date.now(), parts: [{ type: "text", text: "Interrupted" }] } });
      emit(s, { type: "state", state: { status: "idle" } });
      upsert(s);
      return null;
    }
    case "setModel":
      emit(get(a.sessionId), { type: "state", state: { model: a.model, modelResolved: MODELS.models.find((m) => m.id === a.model)?.resolved } });
      return null;
    case "setEffort":
      emit(get(a.sessionId), { type: "state", state: { effort: a.effort } });
      return null;
    case "setPermissionMode":
      emit(get(a.sessionId), { type: "state", state: { permissionMode: a.mode } });
      return null;
  }
  throw new Error(`fake runner doesn't know ${op}`);
}

/** A scripted turn: thinking and text streamed as deltas, a shell call, and a subagent. */
function send(s: Sess, text: string) {
  if (s.state.status === "running") throw new Error("Claude is working; stop it first.");
  const at = (ms: number, f: () => void) => s.timers.push(setTimeout(f, ms));
  if (s.summary.title === "New session") s.summary.title = text.slice(0, 80);
  emit(s, { type: "msg", isNew: true, msg: user(text, Date.now()) });
  emit(s, { type: "state", state: { status: "running", mode: "live" } });
  upsert(s);
  const m: Msg = { id: id("a"), role: "assistant", ts: Date.now(), model: "claude-haiku-5-5", streaming: true, parts: [] };
  at(300, () => emit(s, { type: "msg", isNew: true, msg: { ...m, parts: [{ type: "thinking", text: "" }] } }));
  const thought = "Let me think about this request carefully. ";
  [...thought.split(" ")].forEach((w, i) => at(400 + i * 40, () => emit(s, { type: "delta", msgId: m.id, part: 0, text: w + " " })));
  // "long …" streams for about 20 s (scroll checks while a reply streams).
  const body = text.startsWith("long") ? Array.from({ length: 12 }, (_, k) => `${prose(k, 60)}\n\n${k % 3 === 0 ? code(k, 8) + "\n\n" : ""}`).join("") : "";
  const reply = `Sure. Here is a **streamed** reply to: _${text.slice(0, 60)}_\n\n1. First point\n2. Second point with \`code\`\n\n${body}`.split(/(?<= )/);
  at(800, () => emit(s, { type: "msg", msg: { ...s.messages.find((x) => x.id === m.id)!, parts: [...s.messages.find((x) => x.id === m.id)!.parts, { type: "text", text: "" }] } }));
  reply.forEach((w, i) => at(850 + i * 50, () => emit(s, { type: "delta", msgId: m.id, part: 1, text: w })));
  const t0 = 900 + reply.length * 50;
  const sh = tool("Bash", "shell", { command: "ls -la", description: "List files" }, undefined, { status: "running" });
  at(t0, () => {
    const cur = s.messages.find((x) => x.id === m.id)!;
    emit(s, { type: "msg", msg: { ...cur, parts: [...cur.parts, sh] } });
  });
  at(t0 + 700, () => emit(s, { type: "tool", msgId: m.id, toolId: sh.id, patch: { status: "done", output: "total 8\ndrwxr-xr-x  src\n-rw-r--r--  package.json" } }));
  // A subagent: a child session that streams its own turns.
  const childSid = `${s.summary.id}/agent-${n}`;
  const task = tool("Agent", "task", { description: "Check the tests", prompt: "Run the tests and report.", subagent_type: "general-purpose" }, undefined, { status: "running", childSessionId: childSid });
  at(t0 + 900, () => {
    const cur = s.messages.find((x) => x.id === m.id)!;
    emit(s, { type: "msg", msg: { ...cur, parts: [...cur.parts, task] } });
    const c = add({ id: childSid, title: "Check the tests", projectPath: s.summary.projectPath, parentSessionId: s.summary.id, parentToolId: task.id, agentType: "general-purpose" }, [user("Run the tests and report.")], { mode: "live", status: "running" });
    upsert(c);
    const cm = asst([tool("Bash", "shell", { command: "bun test" }, undefined, { status: "running" })]);
    c.timers.push(setTimeout(() => emit(c, { type: "msg", isNew: true, msg: cm }), 500));
    c.timers.push(setTimeout(() => emit(c, { type: "tool", msgId: cm.id, toolId: (cm.parts[0] as ToolPart).id, patch: { status: "done", output: "12 pass\n0 fail" } }), 2500));
    c.timers.push(
      setTimeout(() => {
        emit(c, { type: "msg", isNew: true, msg: asst([{ type: "text", text: "All **12** tests pass." }]) });
        emit(c, { type: "state", state: { status: "idle" } });
        upsert(c);
      }, 3000),
    );
  });
  at(t0 + 4200, () => emit(s, { type: "tool", msgId: m.id, toolId: task.id, patch: { status: "done", output: "All 12 tests pass." } }));
  at(t0 + 4400, () => {
    const cur = s.messages.find((x) => x.id === m.id)!;
    emit(s, { type: "msg", msg: { ...cur, streaming: false, parts: [...cur.parts, { type: "text", text: "Done. Everything passes." }] } });
    emit(s, { type: "state", state: { status: "idle" } });
    upsert(s);
  });
  return null;
}

conn.start();
console.log(`fake runner ${runnerId} dialing ${url}`);
