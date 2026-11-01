// Moving sessions between harnesses (SPEC §15), real Claude Code and the real Codex daemon, desktop
// (1280) and phone (375):
//   PLAYWRIGHT=/path/to/playwright/index.mjs node scripts/e2e-move.mjs [step…]
// Needs a server, a dev runner and vite (docs/acceptance/P6-move.md Setup).
// Environment:
//   BASE, RUNNER      the web app and the dev runner's id
//   CODEX_MODEL       default gpt-6-luna, Low; CLAUDE_MODEL default claude-haiku-5-5
//   CLAUDE_SCRATCH    the folder sessions start in
//   CONFIG_DIR        the dev runner's config dir (to see the private history file)
//   SHOTS             where screenshots go
// Steps:
//   errors    a running turn is refused, Cancel does nothing, phone and desktop dialogs (Claude only)
//   stored    a real Codex thread from the store to Claude: a real tool result, answered (no Codex usage)
//   keyRefused a made-up Anthropic key: the API colour, the loud badge, and no fallback to the plan
//   long      a session bigger than the window moves twice; its first line is only in the file.
//             CODEX_TURNS=1 asks Codex on the way
//   round     Claude to Codex and back: tool call, image, an edit on each side, source unchanged
//   codexFirst a session started on Codex moves to Claude, on a phone
//   fallback  needs a runner with TETHER_MOVE_ROUTE=context: the file route, on both targets

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const HOME = process.env.HOME;
const BASE = process.env.BASE ?? "http://127.0.0.1:5271";
const RUNNER = process.env.RUNNER ?? "tether-dev-move";
const SHOTS = process.env.SHOTS ?? "/tmp/claude-1001/move/shots";
const SCRATCH = process.env.CLAUDE_SCRATCH ?? `${HOME}/.local/share/tether-dev-p3/projects/scratch`;
const CODEX_MODEL = process.env.CODEX_MODEL ?? "gpt-6-luna";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-haiku-5-5";
const CONFIG_DIR = process.env.CONFIG_DIR ?? "/tmp/claude-1001/move/dev";
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
const errors = [];
const page = async (ctx, url = BASE) => {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(url);
  return p;
};
const shot = (p, name) => p.screenshot({ path: `${SHOTS}/${name}.png` });
const ok = (m) => console.log(`ok  ${m}`);
const fail = (m) => {
  throw new Error(m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const token = (w) => `${w}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const composer = (p) => p.locator("textarea.t-input[aria-label=Message]");
const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const MOD = (name) => `(performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/${name}")) ?? "/src/${name}")`;
const sessionUrl = (id) => `${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`;
const idOf = (p) => decodeURIComponent(p.url().split("/").pop());
const rpcVia = (p, op, args) =>
  p.evaluate(
    async ([runnerId, op, args, conn]) => {
      const { rpc } = await import(eval(conn));
      try {
        return { ok: await rpc(runnerId, op, args) };
      } catch (e) {
        return { error: e.message };
      }
    },
    [RUNNER, op, args, MOD("connection.ts")],
  );
const stateOf = (p) =>
  p.evaluate(async (store) => {
    const { useStore } = await import(eval(store));
    const id = decodeURIComponent(location.hash.split("/").pop());
    return Object.entries(useStore.getState().views).find(([k]) => k.endsWith(`\u0000${id}`))?.[1]?.state ?? null;
  }, MOD("store.ts"));
const waitState = async (p, pred, what, ms = 120_000) => {
  const end = Date.now() + ms;
  let st;
  while (Date.now() < end) {
    st = await stateOf(p);
    if (st && pred(st)) return st;
    await sleep(300);
  }
  fail(`${what}: ${JSON.stringify(st && { mode: st.mode, status: st.status, requests: st.requests?.length, error: st.error })}`);
};
/** Approves what the agent asks until its turn ends; then its last reply. */
async function turn(p, text, { approve = false, ms = 240_000 } = {}) {
  await sleep(1000);
  await waitState(p, (s) => s.status === "idle", "idle before the turn");
  const n = await p.locator(".t-msg.assistant").count();
  await composer(p).fill(text);
  await composer(p).press("Enter");
  const end = Date.now() + ms;
  await waitState(p, (s) => s.status !== "idle", "the turn started", 60_000).catch(() => {});
  for (;;) {
    const st = await stateOf(p);
    if (st?.status === "idle" && (await p.locator(".t-msg.assistant").count()) >= n) break;
    if (Date.now() > end) fail(`the turn never ended: ${JSON.stringify(st?.status)}`);
    const req = p.locator(".t-req").first();
    if (approve && (await req.count())) await button(req, "Approve").click().catch(() => {});
    if (!approve && st?.requests?.length) fail(`it asked for ${st.requests[0].tool}`);
    await sleep(500);
  }
  return (await p.locator(".t-msg.assistant").last().innerText()).trim();
}
const newSession = async (p, harness, mode) => {
  const r = await rpcVia(p, "newSession", { harness, projectPath: SCRATCH, model: harness === "codex" ? CODEX_MODEL : CLAUDE_MODEL, permissionMode: mode });
  if (r.error) fail(r.error);
  const id = r.ok.sessionId;
  await rpcVia(p, "setEffort", { sessionId: id, effort: "low" });
  await p.goto(sessionUrl(id));
  await composer(p).waitFor({ timeout: 30_000 });
  return id;
};
const openMenu = async (p, tap) => {
  const m = p.getByRole("button", { name: "Session menu" });
  await m.waitFor({ timeout: 30_000 });
  await (tap ? m.tap() : m.click());
  const item = p.getByRole("menuitem", { name: "Move to…" });
  await (tap ? item.tap() : item.click());
  await p.getByRole("dialog").waitFor();
};
/** Moves through the dialog; returns the new session's id. */
async function move(p, label, model, { tap = false, name } = {}) {
  const was = idOf(p);
  await openMenu(p, tap);
  const d = p.getByRole("dialog");
  await d.locator("select.t-select").first().waitFor({ timeout: 30_000 });
  // Claude lists aliases ("haiku"): the one that resolves to this model, by its family name.
  const word = model.replace(/^claude-/, "").split("-")[0];
  const value = await p.waitForFunction(([m, w]) => [...document.querySelectorAll("dialog select option, [role=dialog] select option")].find((o) => o.value === m || o.value === w || o.value.includes(w))?.value, [model, word], { timeout: 40_000 });
  await d.locator("select.t-select").first().selectOption(await value.jsonValue());
  const eff = d.locator("select.t-select").nth(1);
  if ((await eff.count()) && (await eff.locator('option[value="low"]').count())) await eff.selectOption("low");
  if (!(await d.innerText()).includes(label)) fail(`the dialog doesn't offer ${label}`);
  await shot(p, `${name ?? `move-${label}`}-dialog`);
  await button(d, "Move").click();
  await Promise.race([
    p.waitForFunction((was) => !decodeURIComponent(location.hash).includes(was), was, { timeout: 90_000 }),
    d.locator(".t-form-error").waitFor({ timeout: 90_000 }).then(async () => fail(`the move failed: ${await d.locator(".t-form-error").innerText()}`)),
  ]);
  await composer(p).waitFor({ timeout: 30_000 });
  await p.locator(".t-msg.notice", { hasText: "Moved from" }).first().waitFor({ timeout: 30_000 });
  const id = idOf(p);
  if (id === was) fail("the new session didn't open");
  return id;
}
const storeFile = (nativeId) => `${HOME}/.claude/projects/${SCRATCH.replace(/[^a-zA-Z0-9]/g, "-")}/${nativeId}.jsonl`;
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const noOverflow = async (p, where) => {
  const w = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (w > 1) fail(`${where}: page scrolls sideways by ${w}px`);
};
const has = (reply, ...words) => {
  for (const w of words) if (!reply.includes(w)) fail(`the reply lacks ${w}: ${reply.slice(0, 400)}`);
};
const png = (w, rgb) => {
  // A solid square: enough for a model to name its color.
  const py = `import zlib,struct,sys
w=${w};raw=b''.join(b'\\0'+bytes(${JSON.stringify(rgb)})*w for _ in range(w))
c=lambda t,d:struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d))
sys.stdout.buffer.write(b'\\x89PNG\\r\\n\\x1a\\n'+c(b'IHDR',struct.pack('>IIBBBBB',w,w,8,2,0,0,0))+c(b'IDAT',zlib.compress(raw))+c(b'IEND',b''))`;
  return execFileSync("python3", ["-c", py]);
};

const steps = {
  /** Refusal, Cancel, both widths. */
  async errors() {
    const p = await page(desktop);
    const id = await newSession(p, "claude", "default");
    if (!(await turn(p, "Reply with the single word ready. Do not use tools."))) fail("no reply");
    await composer(p).fill("Count slowly from 1 to 40, one number a line. Do not use tools.");
    await composer(p).press("Enter");
    await waitState(p, (s) => s.status === "running", "running");
    const r = await rpcVia(p, "moveSession", { sessionId: id, harness: "codex" });
    if (!/Wait for the turn/.test(r.error ?? "")) fail(`a running turn moved: ${JSON.stringify(r)}`);
    await openMenu(p);
    await p.locator(".t-form-error", { hasText: "Wait for the turn" }).waitFor();
    if (await button(p.getByRole("dialog"), "Move").isEnabled()) fail("Move is enabled while a turn runs");
    await shot(p, "refused");
    await button(p.getByRole("dialog"), "Cancel").click();
    ok("a running turn is refused, in the op and the dialog");
    await waitState(p, (s) => s.status === "idle", "idle");
    const before = (await rpcVia(p, "listSessions", { query: "" })).ok?.sessions?.length;
    await openMenu(p);
    await button(p.getByRole("dialog"), "Cancel").click();
    if (idOf(p) !== id) fail("Cancel moved something");
    if ((await rpcVia(p, "listSessions", { query: "" })).ok?.sessions?.length !== before) fail("Cancel made a session");
    ok("Cancel does nothing");
    const f = await page(phone, sessionUrl(id));
    await openMenu(f, true);
    await noOverflow(f, "the phone's dialog");
    await shot(f, "phone-dialog");
    await button(f.getByRole("dialog"), "Cancel").tap();
    ok("the dialog fits a phone");
    await p.close();
    await f.close();
  },

  /** A real Codex thread from the store, with real tool calls, to Claude; no Codex usage. */
  async stored() {
    const p = await page(desktop);
    const folder = process.env.CODEX_SCRATCH ?? `${HOME}/tether-scratch/p4/projects/scratch`;
    const list = (await rpcVia(p, "listSessions", { projectPath: folder })).ok?.sessions.filter((s) => s.harness === "codex" && !/probe/i.test(s.title)) ?? [];
    let picked;
    for (const s of list.slice(0, 120)) {
      const snap = (await rpcVia(p, "subscribe", { sessionId: s.id, limit: 200 })).ok;
      const tool = snap?.messages.flatMap((m) => m.parts).find((x) => x.type === "tool" && x.command && (x.output ?? "").trim().length > 8 && (x.output ?? "").length < 2000);
      if (tool && snap.state.status === "idle") {
        picked = { id: s.id, tool };
        break;
      }
    }
    if (!picked) fail("no stored Codex thread with a shell call here");
    await p.goto(sessionUrl(picked.id));
    const target = await move(p, "Claude Code", CLAUDE_MODEL, { name: "stored" });
    await shot(p, "stored-moved");
    const reply = await turn(p, `In the history there's a shell command \`${picked.tool.command.slice(0, 200)}\`. Quote the first 40 characters of its output exactly. Don't run anything.`, { approve: false });
    has(reply, picked.tool.output.trim().slice(0, 12));
    ok(`Claude quotes a real Codex tool result (${target})`);
    await p.close();
  },

  /** With a key set, the dialog and the session say so loudly, and a refused key stops there. */
  async keyRefused() {
    const p = await page(desktop);
    const folder = process.env.CODEX_SCRATCH ?? `${HOME}/tether-scratch/p4/projects/scratch`;
    const src = (await rpcVia(p, "listSessions", { projectPath: folder })).ok?.sessions.find((s) => s.harness === "codex" && !s.parentSessionId);
    if (!src) fail("no stored Codex thread");
    const set = await rpcVia(p, "setCredential", { source: "anthropic", key: `sk-ant-not-a-real-key-${"x".repeat(24)}` });
    if (set.error) fail(set.error);
    try {
      await p.goto(sessionUrl(src.id));
      await openMenu(p);
      await p.locator(".t-move-api", { hasText: "Anthropic API key" }).waitFor({ timeout: 30_000 });
      if ((await p.locator(".t-move-api").evaluate((e) => getComputedStyle(e).borderRadius)) === "0px") fail("the API colour isn't styled");
      await shot(p, "key-dialog");
      await button(p.getByRole("dialog"), "Cancel").click();
      await move(p, "Claude Code", CLAUDE_MODEL, { name: "key" });
      await p.locator(".t-paid-badge").waitFor({ timeout: 60_000 });
      await shot(p, "key-moved");
      ok("the configured key shows in the dialog and, confirmed, as the loud badge before anything is sent");
      await composer(p).fill("Reply OK.");
      await composer(p).press("Enter");
      await p.getByText("Anthropic API key failed", { exact: false }).first().waitFor({ timeout: 120_000 });
      await waitState(p, (s) => s.status === "idle", "stopped");
      await shot(p, "key-refused");
      if ((await p.locator(".t-paid-badge").count()) === 0) fail("the badge went");
      ok("a refused key stops on that source: nothing goes to the plan");
    } finally {
      await rpcVia(p, "unsetCredential", { source: "anthropic" });
      await p.close();
    }
  },

  /** Bigger than the target's window, moved twice, and something from the very start of it. */
  async long() {
    const early = token("BLUEHERON");
    const late = token("BUILD");
    const nativeId = crypto.randomUUID();
    const filler = "lorem ipsum dolor sit amet consectetur ".repeat(2600); // about 25k tokens
    const base = { isSidechain: false, userType: "external", entrypoint: "sdk-ts", cwd: SCRATCH, sessionId: nativeId, version: "2.1.316" };
    let parentUuid = null;
    let n = 0;
    const line = (role, text) => {
      const uuid = crypto.randomUUID();
      const entry = { ...base, parentUuid, uuid, timestamp: new Date(Date.now() - 3_600_000 + n++ * 1000).toISOString(), type: role, message: role === "user" ? { role, content: text } : { id: crypto.randomUUID(), type: "message", role, model: CLAUDE_MODEL, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } };
      parentUuid = uuid;
      return JSON.stringify(entry);
    };
    const lines = [line("user", `Remember this: the deploy phrase is ${early}.`), line("assistant", "Remembered.")];
    for (let i = 0; i < 14; i++) lines.push(line("user", `Step ${i}: summarize this.\n${filler}`), line("assistant", `Step ${i} done.`));
    lines.push(line("user", "What did the build print?"), line("assistant", `It printed artifact ${late}.`));
    const file = storeFile(nativeId);
    writeFileSync(file, `${lines.join("\n")}\n`);
    await sleep(4000);
    const src = `claude:${nativeId}`;
    const p = await page(desktop, sessionUrl(src));
    const before = sha(file);
    const mid = await move(p, "Codex", CODEX_MODEL, { name: "long-codex" });
    await shot(p, "long-on-codex");
    const said = await p.locator(".t-msg.notice", { hasText: "Moved from" }).first().innerText();
    if (!/\d+ of \d+ messages in context/.test(said)) fail(`the cut isn't shown: ${said}`);
    if (sha(file) !== before) fail("the source changed");
    ok(`over budget on Codex: "${said.trim()}"`);
    if (process.env.CODEX_TURNS === "1") {
      const r = await turn(p, "From this session's history, what's the deploy phrase and what artifact did the build print? Read the history file if you need to. One line.", { approve: true });
      has(r, early, late);
      ok("Codex answers from the start of a history it holds only in a file");
    }
    const back = await move(p, "Claude Code", CLAUDE_MODEL, { name: "long-claude" });
    await shot(p, "long-on-claude");
    const reply = await turn(p, "From this session's history, what's the deploy phrase and what artifact did the build print? Search the history file if you need to, with your Grep tool. One line.", { approve: true });
    has(reply, early, late);
    await shot(p, "long-answered");
    ok(`Claude answers from the start of a history bigger than its window (${back})`);
    await p.close();
  },

  /** A session with a tool call and an image goes across, works there, and comes back. */
  async round() {
    const p = await page(desktop);
    const code = token("VAULT");
    const secret = `secret-${code}.txt`;
    const notes = `notes-${code}.txt`;
    writeFileSync(`${SCRATCH}/${secret}`, `the code is ${code}\n`);
    writeFileSync(`${SCRATCH}/${notes}`, "start\n");
    const id = await newSession(p, "claude", "acceptEdits");
    const redFile = `${SHOTS}/red.png`;
    writeFileSync(redFile, png(64, [220, 20, 20]));
    await p.locator('input[type=file][aria-label="Attach files"]').setInputFiles(redFile);
    await p.locator(".t-files").waitFor();
    await sleep(1500);
    await turn(p, `Use the Read tool on ${secret}. Then reply with just the word done: don't repeat what it says.`, { approve: true });
    const file = storeFile(id.split(":")[1]);
    const before = sha(file);
    const codexId = await move(p, "Codex", CODEX_MODEL, { name: "round-to-codex" });
    await shot(p, "round-on-codex");
    if (sha(file) !== before) fail("the source changed");
    if ((await waitState(p, () => true, "state")).permissionMode !== "untrusted") fail("Accept edits didn't become Ask first");
    const r1 = await turn(p, "From this session's history: what did the file you read say, and what color was the image the user attached? One line. Don't run anything.");
    has(r1, code);
    if (!/red/i.test(r1)) fail(`no color: ${r1}`);
    ok("Codex has the tool result and the image");
    await turn(p, `Append a line saying "from codex" to ${notes}. Nothing else.`, { approve: true });
    if (!readFileSync(`${SCRATCH}/${notes}`, "utf8").includes("from codex")) fail("Codex didn't edit");
    ok("Codex edits in the moved session");
    await shot(p, "round-codex-edit");
    const claudeId = await move(p, "Claude Code", CLAUDE_MODEL, { name: "round-back" });
    await shot(p, "round-back-on-claude");
    const r2 = await turn(p, `From this session's history: what was the code in the secret file, and which line was appended to ${notes}? One line. Don't run anything.`);
    has(r2, code, "from codex");
    await turn(p, `Use the Edit tool to append a line saying "from claude" to ${notes}. Nothing else.`, { approve: true });
    if (!readFileSync(`${SCRATCH}/${notes}`, "utf8").includes("from claude")) fail("Claude didn't edit");
    ok(`round trip ${id} -> ${codexId} -> ${claudeId}`);
    if (sha(file) !== before) fail("the source changed on the way");
    await p.goto(sessionUrl(id));
    await p.locator(".t-msg.notice", { hasText: "Moved to Codex" }).waitFor({ timeout: 30_000 });
    await shot(p, "round-source");
    const f = await page(phone, sessionUrl(claudeId));
    await f.locator(".t-msg.notice", { hasText: "Moved from Codex" }).first().waitFor({ timeout: 30_000 });
    await noOverflow(f, "the moved session on a phone");
    await shot(f, "round-phone");
    await f.locator(".t-msg.notice", { hasText: "Moved from Codex" }).first().getByRole("button", { name: "Open it" }).tap();
    await f.waitForFunction((c) => decodeURIComponent(location.hash).includes(c), codexId, { timeout: 15_000 });
    ok("the two link to each other, on a phone too");
    await p.close();
    await f.close();
  },

  /** A session started on Codex, moved on a phone, goes on in Claude. */
  async codexFirst() {
    const f = await page(phone);
    const code = token("OTTER");
    const notes = `notes-${code}.txt`;
    writeFileSync(`${SCRATCH}/${notes}`, "start\n");
    await newSession(f, "codex", "untrusted");
    await turn(f, `Run the shell command \`echo the-code-is-${code}\` then reply with just the word done.`, { approve: true });
    const id = await move(f, "Claude Code", CLAUDE_MODEL, { tap: true, name: "codex-first" });
    await shot(f, "codex-first-moved");
    if ((await waitState(f, () => true, "state")).permissionMode !== "default") fail("Ask first should stay Ask first");
    has(await turn(f, "What did the command you ran print? One line. Don't run anything."), code);
    await turn(f, `Use the Edit tool to append a line saying "from claude" to ${notes}. Nothing else.`, { approve: true });
    if (!readFileSync(`${SCRATCH}/${notes}`, "utf8").includes("from claude")) fail("Claude didn't edit");
    ok(`Codex to Claude on a phone (${id})`);
    await f.close();
  },

  /** With a runner on TETHER_MOVE_ROUTE=context: nothing native, only the file and the summary. */
  async fallback() {
    const p = await page(desktop);
    const code = token("HERON");
    const secret = `secret-${code}.txt`;
    writeFileSync(`${SCRATCH}/${secret}`, `the code is ${code}\n`);
    const id = await newSession(p, "claude", "acceptEdits");
    await turn(p, `Remember the word MARIGOLD. Use the Read tool on ${secret}. Then reply with just the word done.`, { approve: true });
    await move(p, "Codex", CODEX_MODEL, { name: "fallback-codex" });
    await p.locator(".t-msg.assistant", { hasText: "Ready" }).first().waitFor({ timeout: 180_000 });
    await waitState(p, (s) => s.status === "idle", "idle");
    await shot(p, "fallback-codex");
    const q = "Read the session's history file. What was the word to remember, and what did the file that was read say? One line.";
    const a = await turn(p, q, { approve: true });
    has(a, "MARIGOLD", code);
    ok("Codex reads the private file");
    await move(p, "Claude Code", CLAUDE_MODEL, { name: "fallback-claude" });
    await p.locator(".t-msg.assistant", { hasText: "Ready" }).first().waitFor({ timeout: 180_000 });
    await waitState(p, (s) => s.status === "idle", "idle");
    await shot(p, "fallback-claude");
    const b = await turn(p, q, { approve: false });
    has(b, "MARIGOLD", code);
    ok(`Claude reads the private file with no prompt (${id})`);
    await p.close();
  },
};

const chosen = process.argv.slice(2);
try {
  for (const name of chosen.length ? chosen : Object.keys(steps)) {
    console.log(`-- ${name}`);
    await steps[name]();
  }
  if (errors.length) fail(`page errors: ${errors.join("; ")}`);
  console.log("all ok");
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
