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
//   sourceChange the same harness on another source, on both harnesses, with made-up keys
//   sourceCarry a Codex session changes source from the chip: a refused key stays put, a thread on
//             FAKE_ENDPOINT (scripts/fake-responses.ts, logging to FAKE_LOG) gets the history and takes
//             over, and the real plan answers from it on the way back. Needs both variables
//   long      a session bigger than the window moves twice; its first line is only in the file.
//             CODEX_TURNS=1 asks Codex instead of moving on (run the runner with a small
//             TETHER_MOVE_BUDGET: every request resends what's in context)
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
  // On a phone Enter is a new line.
  if (p.context() === phone) await p.locator('button[aria-label="Send"]').tap();
  else await composer(p).press("Enter");
  const end = Date.now() + ms;
  await waitState(p, (s) => s.status !== "idle", "the turn started", 60_000).catch(() => {});
  for (;;) {
    const st = await stateOf(p);
    if (st?.status === "idle" && (await p.locator(".t-msg.assistant").count()) > n) break;
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
  await confirmModel(p, harness === "codex" ? CODEX_MODEL : CLAUDE_MODEL);
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
/** Only the cheap model ever runs: said by the session itself, before any turn. */
const confirmModel = async (p, model) => {
  const word = model.startsWith("claude-") ? model.split("-")[1] : model;
  const st = await waitState(p, (s) => !!s.model, "a model", 30_000);
  if (![model, word].includes(st.model)) fail(`it would run ${st.model}, not ${model}`);
};
/** Moves through the dialog; returns the new session's id. */
async function move(p, label, model, { tap = false, name, source } = {}) {
  const was = idOf(p);
  await openMenu(p, tap);
  const d = p.getByRole("dialog");
  const modelSelect = d.locator("label", { hasText: "Model" }).locator("select");
  await modelSelect.waitFor({ timeout: 30_000 });
  const seg = d.getByRole("radio", { name: label, exact: true });
  if (await seg.count()) await seg.click();
  if (source) {
    const picker = d.getByLabel("Source", { exact: true });
    if (await picker.count()) await picker.selectOption({ label: source });
    else if (!(await d.innerText()).includes(source)) fail(`the dialog doesn't offer ${source}`);
  }
  // Claude lists aliases ("haiku"): the one that resolves to this model, by its family name.
  const word = model.startsWith("claude-") ? model.split("-")[1] : model;
  const value = await p.waitForFunction(([m, w]) => {
    const all = [...document.querySelectorAll("dialog select option, [role=dialog] select option")];
    return (all.find((o) => o.value === m) ?? all.find((o) => o.value === w))?.value;
  }, [model, word], { timeout: 40_000 });
  await modelSelect.selectOption(await value.jsonValue());
  const eff = d.locator("label", { hasText: "Effort" }).locator("select");
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
  await confirmModel(p, model);
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
    await f.getByRole("button", { name: "Session menu" }).locator("span").waitFor({ state: "visible", timeout: 30_000 });
    await shot(f, "phone-header");
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
      const d = p.getByRole("dialog");
      await d.getByRole("radio", { name: "Claude Code", exact: true }).click().catch(() => {});
      const picker = d.getByLabel("Source", { exact: true });
      await picker.waitFor({ timeout: 30_000 });
      if ((await picker.locator("option:checked").innerText()) !== "Claude plan") fail("the dialog doesn't start on the plan");
      await picker.selectOption({ label: "Anthropic API key" });
      if ((await p.locator(".t-source-api").evaluate((e) => getComputedStyle(e).borderColor)) === "rgba(0, 0, 0, 0)") fail("the API colour isn't styled");
      await shot(p, "key-dialog");
      await button(d, "Cancel").click();
      await move(p, "Claude Code", CLAUDE_MODEL, { name: "key", source: "Anthropic API key" });
      await p.locator(".t-paid-badge").waitFor({ timeout: 60_000 });
      await shot(p, "key-moved");
      ok("the key is offered in the dialog and, chosen and confirmed, is the loud badge before anything is sent");
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

  /** The same harness, another source: a new session with the context, the old one as it was. Fake keys only. */
  async sourceCarry() {
    const endpoint = process.env.FAKE_ENDPOINT, log = process.env.FAKE_LOG;
    if (!endpoint || !log) fail("sourceCarry needs FAKE_ENDPOINT and FAKE_LOG");
    const p = await page(desktop);
    if ((await rpcVia(p, "setCredential", { source: "openai", key: `sk-not-a-real-key-${"z".repeat(24)}` })).error) fail("no key");
    const azure = await rpcVia(p, "setCredential", { source: "azure", key: `fake-azure-${"w".repeat(24)}`, endpoint });
    if (azure.error) fail(azure.error);
    const rows = async () => (await rpcVia(p, "listSessions", { projectPath: folder })).ok.sessions.map((s) => s.id);
    const pick = async (label) => {
      await p.locator(".t-source-chip").click();
      await p.getByRole("menuitemradio", { name: label }).click();
      await p.locator(".t-next-source", { hasText: label }).waitFor({ timeout: 15_000 });
    };
    const send = async (text) => { await composer(p).fill(text); await composer(p).press("Enter"); };
    const folder = process.env.CODEX_SCRATCH ?? `${HOME}/tether-scratch/p4/projects/scratch`;
    const word = token("HERON");
    const made = await rpcVia(p, "newSession", { harness: "codex", projectPath: folder, model: CODEX_MODEL, permissionMode: "read-only", source: "subscription" });
    if (made.error) fail(made.error);
    const first = made.ok.sessionId;
    await rpcVia(p, "setEffort", { sessionId: first, effort: "low" });
    await p.goto(sessionUrl(first));
    await composer(p).waitFor({ timeout: 30_000 });
    await confirmModel(p, CODEX_MODEL);
    await turn(p, `The word is ${word}. Reply with only: noted. Do not use tools.`);
    await rpcVia(p, "renameSession", { sessionId: first, title: "Carry test" });
    await p.locator(".t-usage-chip", { hasText: "ChatGPT plan" }).waitFor({ timeout: 30_000 });
    const size = await p.evaluate(() => document.querySelectorAll(".t-msg").length);

    // A refused key: nothing moves, the message stays, nothing else answers it.
    await p.locator(".t-source-chip").click();
    await p.getByRole("menuitemradio", { name: "OpenAI API key" }).waitFor();
    if (await p.getByRole("menu").getByText("new session", { exact: false }).count()) fail("the menu mentions a new session");
    await shot(p, "carry-menu");
    await p.keyboard.press("Escape");
    await pick("OpenAI API key");
    await shot(p, "carry-next");
    await send("This goes to the fake key.");
    await p.locator(".t-msg.notice.error").first().waitFor({ timeout: 60_000 });
    await shot(p, "carry-refused");
    if (idOf(p) !== first) fail("a refused key changed the session");
    if ((await composer(p).inputValue()) !== "This goes to the fake key.") fail("the message left the box");
    if (!(await p.locator(".t-usage-chip", { hasText: "ChatGPT plan" }).count())) fail("a refused key changed the label");
    if (await p.locator(".t-msg.assistant").filter({ hasText: "fake key" }).count()) fail("something answered");
    if (!(await p.locator(".t-next-source").count())) fail("the change stopped waiting");
    if ((await rows()).filter((id) => id === first).length !== 1) fail("the row went");
    ok("a refused key: same thread, same label, the message in the box, no fallback");
    await composer(p).fill("");

    // A source that answers: the same conversation, on a thread that got all of it.
    const before = readFileSync(log, "utf8").length;
    await pick("Azure");
    await send("Go on, on Azure.");
    await p.waitForFunction((id) => !decodeURIComponent(location.hash).endsWith(id), first, { timeout: 60_000 });
    const second = idOf(p);
    await p.locator(".t-paid-badge", { hasText: "Azure" }).waitFor({ timeout: 30_000 });
    await p.getByText("Go on, on Azure.").first().waitFor({ timeout: 30_000 });
    await p.getByText(word).first().waitFor({ timeout: 30_000 });
    await shot(p, "carry-azure");
    if ((await composer(p).inputValue()) !== "") fail("the sent message stayed in the box");
    if (await p.getByText(/moved (here )?(from|to)/i).count()) fail("the move shows");
    if ((await p.locator(".t-header-title").innerText()) !== "Carry test") fail("the title changed");
    if ((await p.evaluate(() => document.querySelectorAll(".t-msg").length)) < size) fail("history is missing");
    const seen = readFileSync(log, "utf8").slice(before);
    if (!seen.includes(word)) fail("the new thread's request didn't have the history");
    let list = await rows();
    if (list.includes(first) || !list.includes(second)) fail(`rows: ${list.join()}`);
    ok("Azure: followed without a jump in the URL's history; the request carried the history; one row");

    // An old link goes where the conversation is.
    await p.goto(sessionUrl(first));
    await p.waitForFunction((id) => decodeURIComponent(location.hash).endsWith(id), second, { timeout: 30_000 });
    await p.locator(".t-paid-badge", { hasText: "Azure" }).waitFor({ timeout: 30_000 });
    ok("the old link follows");

    // Back, on the real plan: a real model answers from what came across.
    await pick("ChatGPT plan");
    await send("What was the word I gave you? Reply with only the word. Do not use tools.");
    await p.waitForFunction((id) => !decodeURIComponent(location.hash).endsWith(id), second, { timeout: 120_000 });
    const third = idOf(p);
    await p.locator(".t-msg.assistant").filter({ hasText: word }).last().waitFor({ timeout: 120_000 });
    await p.locator(".t-usage-chip", { hasText: "ChatGPT plan" }).waitFor({ timeout: 30_000 });
    if (await p.locator(".t-paid-badge").count()) fail("the badge stayed");
    await shot(p, "carry-back");
    list = await rows();
    if (list.includes(first) || list.includes(second) || !list.includes(third)) fail(`rows: ${list.join()}`);
    const stored = await rpcVia(p, "moveOptions", { sessionId: third });
    if (stored.error) fail(stored.error);
    ok(`back on the plan: a real gpt-6-luna reply from history (${word}), one row, nothing stacked`);
    writeFileSync(`${SHOTS}/carry-ids.json`, JSON.stringify({ first, second, third, word }));
    await p.close();
  },

  async sourceChange() {
    const p = await page(desktop);
    const keys = { anthropic: `sk-ant-not-a-real-key-${"y".repeat(24)}`, openai: `sk-not-a-real-key-${"z".repeat(24)}` };
    for (const [source, key] of Object.entries(keys)) if ((await rpcVia(p, "setCredential", { source, key })).error) fail("no key");
    try {
      const folder = process.env.CODEX_SCRATCH ?? `${HOME}/tether-scratch/p4/projects/scratch`;
      const cases = [
        { harness: "codex", label: "Codex", plan: "ChatGPT plan", key: "OpenAI API key", id: (await rpcVia(p, "listSessions", { projectPath: folder })).ok?.sessions.find((s) => s.harness === "codex" && !s.parentSessionId)?.id, model: CODEX_MODEL },
        { harness: "claude", label: "Claude Code", plan: "Claude plan", key: "Anthropic API key", model: CLAUDE_MODEL },
      ];
      for (const c of cases) {
        if (!c.id) {
          c.id = await newSession(p, c.harness, "default");
          if (!(await turn(p, "Reply with the single word ready. Do not use tools."))) fail("no reply");
        }
        await p.goto(sessionUrl(c.id));
        await composer(p).waitFor({ timeout: 30_000 });
        const before = await stateOf(p);
        const to = await move(p, c.label, c.model, { name: `source-${c.harness}`, source: c.key });
        await p.locator(".t-paid-badge", { hasText: c.key }).waitFor({ timeout: 60_000 });
        await shot(p, `source-${c.harness}-moved`);
        const sessions = (await rpcVia(p, "listSessions", {})).ok.sessions;
        if (sessions.find((s) => s.id === to)?.billing?.label !== c.key) fail("the list has another label");
        await p.goto(sessionUrl(c.id));
        await p.locator(".t-msg.notice", { hasText: `Moved to ${c.key}` }).first().waitFor({ timeout: 30_000 });
        const after = await stateOf(p);
        if (after.billing?.label && after.billing.label === c.key) fail("the old session changed source");
        if (after.model !== before.model) fail("the old session changed");
        ok(`${c.label}: moved to ${c.key} with its context, confirmed before anything is sent; the old session is as it was`);
      }
    } finally {
      for (const source of Object.keys(keys)) await rpcVia(p, "unsetCredential", { source });
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
      await p.close();
      return;
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
    if (!(await f.getByRole("button", { name: "Session menu" }).locator("span").isVisible())) fail("the menu's glyph is hidden on a phone");
    // (Not tap(): following the bottom scrolls it away again under a synthetic tap.)
    await f.locator(".t-msg.notice", { hasText: "Moved from Codex" }).first().getByRole("button", { name: "Open it" }).evaluate((b) => b.click());
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
