// Forking sessions (SPEC §16), real Claude Code (Haiku) and the real Codex daemon (CODEX_MODEL, Low),
// desktop (1280) and phone (375):
//   PLAYWRIGHT=/path/to/playwright/index.mjs node scripts/e2e-fork.mjs [step…]
// Needs a server, a dev runner and vite (docs/acceptance/P6-move.md Setup, with this script).
// Environment: BASE, RUNNER, SCRATCH (the folder sessions start in), SHOTS, CODEX_MODEL.
// Steps:
//   claude  desktop: two turns; Fork from the menu remembers both; Fork from here on the first reply
//           remembers only the first; the original's store is unchanged; a fork while a turn runs
//           takes only the finished turns
//   phone   the same session on a phone: Fork from here shows without hover and opens the fork
//   codex   on a phone: the same on Codex, through thread/fork

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const HOME = process.env.HOME;
const BASE = process.env.BASE ?? "http://127.0.0.1:5196";
const RUNNER = process.env.RUNNER ?? "tether-f6";
const SHOTS = process.env.SHOTS ?? "/tmp/tether-f6-shots";
const SCRATCH = process.env.SCRATCH ?? `${HOME}/.local/share/tether-f6/scratch`;
const CODEX_MODEL = process.env.CODEX_MODEL ?? "gpt-5.6-luna";
const CLAUDE_MODEL = "haiku";
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
const token = (w) => `${w}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const composer = (p) => p.locator("textarea.t-input[aria-label=Message]");
const MOD = (name) => `(performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/${name}")) ?? "/src/${name}")`;
const sessionUrl = (id) => `${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`;
/** The open session's id: from #/s/…, or a short link #/l/… through the page's own cache. */
const idOf = (p) =>
  p.evaluate(async (route) => {
    const { parseRoute, resolveRoute } = await import(eval(route));
    const r = resolveRoute(parseRoute(location.hash));
    return r.page === "session" ? r.sessionId : location.hash;
  }, MOD("route.ts"));
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
const viewOf = (p) =>
  p.evaluate(async ([store, route]) => {
    const { useStore } = await import(eval(store));
    const { parseRoute, resolveRoute } = await import(eval(route));
    const r = resolveRoute(parseRoute(location.hash));
    const id = r.page === "session" ? r.sessionId : "";
    const v = Object.entries(useStore.getState().views).find(([k]) => k.endsWith(`\u0000${id}`))?.[1];
    return v ? { state: v.state, messages: v.window?.messages ?? [] } : null;
  }, [MOD("store.ts"), MOD("route.ts")]);
const waitState = async (p, pred, what, ms = 120_000) => {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = await viewOf(p);
    if (v?.state && pred(v.state)) return v.state;
    await sleep(300);
  }
  fail(`${what}: ${JSON.stringify(v?.state && { mode: v.state.mode, status: v.state.status })}`);
};
const send = async (p, text) => {
  await composer(p).fill(text);
  if (p.context() === phone) await p.locator('button[aria-label="Send"]').tap();
  else await composer(p).press("Enter");
};
/** One turn; its last reply. */
async function turn(p, text, ms = 180_000) {
  await waitState(p, (s) => s.status === "idle", "idle before the turn");
  const n = await p.locator(".t-msg.assistant").count();
  await send(p, text);
  await waitState(p, (s) => s.status !== "idle", "the turn started", 60_000).catch(() => {});
  const end = Date.now() + ms;
  for (;;) {
    const v = await viewOf(p);
    if (v?.state.status === "idle" && (await p.locator(".t-msg.assistant").count()) > n) break;
    if (v?.state.requests?.length) fail(`it asked for ${v.state.requests[0].tool}`);
    if (Date.now() > end) fail("the turn never ended");
    await sleep(500);
  }
  return (await p.locator(".t-msg.assistant").last().innerText()).replace(/\s*Fork from here\s*$/, "").trim();
}
const newSession = async (p, harness) => {
  const model = harness === "codex" ? CODEX_MODEL : CLAUDE_MODEL;
  const r = await rpcVia(p, "newSession", { harness, projectPath: SCRATCH, model, effort: "low", permissionMode: harness === "codex" ? "read-only" : "default" });
  if (r.error) fail(r.error);
  const id = r.ok.sessionId;
  await rpcVia(p, "setEffort", { sessionId: id, effort: "low" });
  await p.goto(sessionUrl(id));
  await composer(p).waitFor({ timeout: 30_000 });
  return id;
};
/** Waits for the fork to open; its id. */
async function opened(p, was) {
  for (let i = 0; (await idOf(p)) === was; i++) {
    if (i > 200) fail("the fork didn't open");
    await sleep(300);
  }
  await p.locator(".t-header-fork", { hasText: "Forked from" }).waitFor({ timeout: 30_000 });
  await p.locator(".t-msg.notice", { hasText: "Forked from" }).first().waitFor({ timeout: 30_000 });
  return idOf(p);
}
async function forkFromMenu(p) {
  const was = await idOf(p);
  const tap = p.context() === phone;
  const m = p.getByRole("button", { name: "Session menu" });
  await (tap ? m.tap() : m.click());
  const item = p.getByRole("menuitem", { name: "Fork", exact: true });
  await (tap ? item.tap() : item.click());
  return opened(p, was);
}
async function forkFromHere(p, replyText) {
  const was = await idOf(p);
  const reply = p.locator(".t-msg.assistant", { hasText: replyText.slice(0, 40) }).first();
  await reply.waitFor({ timeout: 30_000 }).catch(async () => {
    await shot(p, "fork-from-here-missing");
    fail(`no reply saying "${replyText}": ${JSON.stringify((await said(p)).map((m) => m.parts))}`.slice(0, 600));
  });
  const b = reply.getByRole("button", { name: "Fork from here" });
  // Up to it as a reader would (a programmatic scroll doesn't stop the transcript following the bottom).
  const box = await p.locator(".t-scroll").boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 40; i++) {
    const r = await b.boundingBox();
    if (r && r.y > box.y + 20 && r.y + r.height < box.y + box.height - 20) break;
    await p.mouse.wheel(0, r && r.y > box.y + box.height ? 300 : -300);
    await sleep(150);
  }
  await sleep(500);
  if (p.context() === phone) {
    if (!(await b.isVisible())) fail("Fork from here isn't visible on a phone");
    await b.tap();
  } else {
    await reply.hover();
    await b.click();
  }
  return opened(p, was);
}
const textOf = (m) => (m?.parts ?? []).map((x) => x.text ?? "").join("\n");
/** What the fork's store-backed transcript says, minus notices. */
const said = async (p) => ((await viewOf(p))?.messages ?? []).filter((m) => m.role !== "notice");
const claudeFile = (nativeId) => `${HOME}/.claude/projects/${SCRATCH.replace(/[^a-zA-Z0-9]/g, "-")}/${nativeId}.jsonl`;
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const noOverflow = async (p, where) => {
  const w = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (w > 1) fail(`${where}: page scrolls sideways by ${w}px`);
};

let claudeOrig;
let claudeFirst;

/** Checks a fork: stored (nothing started), ends at `lastText`, the menu's settings, then asks it what it remembers. */
async function checkFork(p, { name, harness, expectWords, notWords, lastText }) {
  const st = (await viewOf(p)).state;
  if (st.mode !== "stored") fail(`${name}: the fork started (${st.mode}) before anything was sent`);
  const msgs = await said(p);
  const last = msgs.at(-1);
  if (!last || last.role !== "assistant" || !textOf(last).includes(lastText)) fail(`${name}: the fork doesn't end at "${lastText}": ${JSON.stringify(last?.parts).slice(0, 200)}`);
  const model = harness === "codex" ? CODEX_MODEL : "haiku";
  if (!String(st.model).includes(model)) fail(`${name}: it would run ${st.model}`);
  await shot(p, `${name}-opened`);
  const reply = await turn(p, "List every code word I asked you to remember in this conversation, nothing else. Do not use tools.");
  for (const w of expectWords) if (!reply.includes(w)) fail(`${name}: forgot ${w}: ${reply}`);
  for (const w of notWords) if (reply.includes(w)) fail(`${name}: remembers ${w}, which came after the fork point: ${reply}`);
  await shot(p, `${name}-answered`);
  ok(`${name}: stored until sent, ends at its point, remembers ${expectWords.join(", ")}${notWords.length ? `, not ${notWords.join(", ")}` : ""}`);
}

const steps = {
  async claude() {
    const p = await page(desktop);
    const id = await newSession(p, "claude");
    claudeOrig = id;
    const [a, b] = [token("ALPHA"), token("BRAVO")];
    const r1 = await turn(p, `Remember the code word ${a}. Reply with exactly: noted one. Do not use tools.`);
    const r2 = await turn(p, `Also remember the code word ${b}. Reply with exactly: noted two. Do not use tools.`);
    claudeFirst = r1;
    const file = claudeFile(id.slice("claude:".length));
    const before = sha(file);
    // Fork from here only on replies that end a turn: both replies here.
    if ((await p.locator(".t-fork-here").count()) !== 2) fail(`expected 2 Fork from here, saw ${await p.locator(".t-fork-here").count()}`);
    await shot(p, "claude-original");

    const whole = await forkFromMenu(p);
    await checkFork(p, { name: "claude-fork", harness: "claude", expectWords: [a, b], notWords: [], lastText: r2 });
    if (sha(file) !== before) fail("forking changed the original's store");

    await p.goto(sessionUrl(id));
    await composer(p).waitFor();
    const early = await forkFromHere(p, r1);
    if (early === whole) fail("the same fork twice");
    await checkFork(p, { name: "claude-fork-early", harness: "claude", expectWords: [a], notWords: [b], lastText: r1 });
    if (sha(file) !== before) fail("forking changed the original's store");
    // The fork's header leads back.
    await p.locator(".t-header-fork button").click();
    for (let i = 0; (await idOf(p)) !== id; i++) {
      if (i > 60) fail("Forked from didn't open the original");
      await sleep(300);
    }
    ok("the header's Forked from opens the original");

    // A fork while a turn runs: only the finished turns.
    await send(p, "Count from 1 to 300, one number a line. Do not use tools.");
    await waitState(p, (s) => s.status === "running", "the long turn running", 60_000);
    const n = await p.locator(".t-fork-here").count();
    if ((await viewOf(p)).state.status !== "idle" && n !== 2) fail(`the running turn offers Fork from here (${n})`);
    const running = await forkFromMenu(p);
    const msgs = await said(p);
    if (JSON.stringify(msgs).includes("Count from 1 to 300")) fail("a fork while a turn ran took the running turn");
    if (!textOf(msgs.at(-1)).includes(r2)) fail("a fork while a turn ran doesn't end at the last finished turn");
    ok(`a fork while a turn runs (${running}) ends at the last finished turn`);
    await p.goto(sessionUrl(id));
    await composer(p).waitFor();
    await rpcVia(p, "interrupt", { sessionId: id });
    await waitState(p, (s) => s.status === "idle", "the long turn stopped");
    ok("claude on desktop");
  },

  async phone() {
    if (!claudeOrig) fail("run the claude step first");
    const p = await page(phone, sessionUrl(claudeOrig));
    await composer(p).waitFor({ timeout: 30_000 });
    await noOverflow(p, "the original on a phone");
    const id = await forkFromHere(p, claudeFirst);
    await noOverflow(p, "a fork on a phone");
    const msgs = await said(p);
    if (!textOf(msgs.at(-1)).includes(claudeFirst)) fail("the phone's fork doesn't end at the first reply");
    if (!(await p.locator(".t-header-fork").isVisible())) fail("Forked from isn't visible on a phone");
    await shot(p, "phone-fork");
    ok(`on a phone, Fork from here shows without hover and opens ${id}`);
  },

  async codex() {
    const p = await page(phone);
    const id = await newSession(p, "codex");
    const [a, b] = [token("CHARLIE"), token("DELTA")];
    const r1 = await turn(p, `Remember the code word ${a}. Reply with exactly: noted one. Do not run any commands.`);
    const r2 = await turn(p, `Also remember the code word ${b}. Reply with exactly: noted two. Do not run any commands.`);
    const original = JSON.stringify(await said(p));
    await shot(p, "codex-original");
    await forkFromMenu(p);
    await checkFork(p, { name: "codex-fork", harness: "codex", expectWords: [a, b], notWords: [], lastText: r2 });
    await p.goto(sessionUrl(id));
    await composer(p).waitFor();
    await forkFromHere(p, r1);
    await checkFork(p, { name: "codex-fork-early", harness: "codex", expectWords: [a], notWords: [b], lastText: r1 });
    await p.goto(sessionUrl(id));
    await composer(p).waitFor();
    await sleep(1500);
    if (JSON.stringify(await said(p)) !== original) fail("the original Codex thread changed");
    ok("codex on a phone; the original thread unchanged");
  },
};

try {
  for (const s of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(steps)) {
    console.log(`-- ${s}`);
    await steps[s]();
  }
  if (errors.length) fail(`page errors: ${errors.join("; ")}`);
  console.log("all ok");
} finally {
  await browser.close();
}
