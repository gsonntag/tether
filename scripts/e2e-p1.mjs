// P1 end-to-end against a local dev stack and REAL Claude (Haiku), desktop and phone:
//   PLAYWRIGHT=/path/to/playwright/index.mjs node scripts/e2e-p1.mjs [step…]
// Needs: server on :8790, the dev runner `tether-dev`, vite on :5180 (README "Local development").
// Steps: new stream twodev interrupt reopen subagent restart paging. Screenshots go to $SHOTS.
// Each real turn is small; the whole run is a handful of Haiku turns.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const BASE = process.env.BASE ?? "http://127.0.0.1:5180";
const SHOTS = process.env.SHOTS ?? "/tmp/tether-e2e-p1";
const SCRATCH = `${process.env.HOME}/.local/share/tether-dev/projects/scratch`;
const LONG = process.env.LONG_SESSION; // claude:<id> of a long stored session, for paging
const RESTART = process.env.RESTART_RUNNER; // a command that restarts the dev runner
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
const ok = (msg) => console.log(`ok  ${msg}`);
const fail = (msg) => {
  throw new Error(msg);
};
const transcriptText = (p) => p.$$eval(".t-msg", (els) => els.map((e) => e.innerText.trim()).join("\n---\n"));
const noOverflow = async (p, where) => {
  const w = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (w > 1) fail(`${where}: page scrolls sideways by ${w}px`);
};
const composer = (p) => p.locator("textarea.t-input");
const idle = (p, ms = 120_000) => p.locator('button[aria-label="Send"]').waitFor({ timeout: ms });
const running = (p, ms = 60_000) => p.locator('button[aria-label="Stop"]').first().waitFor({ timeout: ms });
async function send(p, text) {
  await composer(p).fill(text);
  await composer(p).press("Enter");
}

let session; // the hash URL of the session made in `new`
const steps = {
  async new() {
    const p = await page(desktop);
    await p.getByRole("button", { name: "New session" }).first().click();
    await p.locator("#t-new-path").fill(SCRATCH);
    const selects = p.locator(".t-form select.t-select");
    await p.waitForFunction(() => [...document.querySelectorAll(".t-form select option")].some((o) => o.value === "haiku"), null, { timeout: 30_000 });
    await selects.nth(0).selectOption("haiku");
    await selects.nth(1).selectOption("bypassPermissions");
    await shot(p, "new-dialog");
    await p.getByRole("button", { name: "Create" }).click();
    await p.waitForURL(/#\/s\//, { timeout: 60_000 });
    session = p.url();
    if (!(await composer(p).evaluate((e) => e === document.activeElement))) fail("composer not focused after create");
    ok(`new session ${decodeURIComponent(session.split("#")[1])}, composer focused`);
    await p.close();
  },
  async stream() {
    const p = await page(desktop, session);
    await send(p, "Reply with one short sentence about lighthouses, then read README.md with the Read tool and quote its first line.");
    await running(p);
    await p.waitForFunction(() => [...document.querySelectorAll(".t-msg.assistant")].some((e) => e.textContent.length > 20), null, { timeout: 60_000 });
    await idle(p);
    await p.locator(".t-tool").first().waitFor();
    const t = await transcriptText(p);
    if (!/# Scratch/.test(t)) fail("reply doesn't quote README");
    const header = await p.locator(".t-header").innerText();
    if (!/Haiku/.test(header)) fail(`header doesn't name the model: ${header}`);
    await shot(p, "desktop-session");
    await noOverflow(p, "desktop session");
    ok(`streamed a reply with a Read card; header: ${header.replace(/\s+/g, " ").slice(0, 120)}`);
    await p.close();
  },
  async twodev() {
    const a = await page(desktop, session);
    const b = await page(phone, session);
    await a.locator(".t-msg").first().waitFor();
    await b.locator(".t-msg").first().waitFor();
    await send(a, "Say the word 'banana' and nothing else.");
    await running(b);
    await idle(a);
    await idle(b);
    await b.waitForFunction(() => document.body.innerText.toLowerCase().includes("banana"), null, { timeout: 30_000 });
    const [ta, tb] = [await transcriptText(a), await transcriptText(b)];
    if (ta !== tb) fail(`desktop and phone differ:\n${ta.slice(-400)}\n=====\n${tb.slice(-400)}`);
    await shot(b, "phone-session");
    await noOverflow(b, "phone session");
    ok("desktop and phone show identical transcripts; phone saw the turn run");
    await a.close();
    await b.close();
  },
  async interrupt() {
    const p = await page(desktop, session);
    await send(p, "Write a 500-word story about a lighthouse keeper. No tools.");
    await p.waitForFunction(() => [...document.querySelectorAll(".t-msg.assistant")].at(-1)?.innerText.length > 80, null, { timeout: 60_000 });
    await composer(p).press("Escape");
    await idle(p, 30_000);
    await p.getByText("Interrupted", { exact: true }).last().waitFor({ timeout: 15_000 });
    ok("Esc interrupted the turn; an Interrupted notice shows");
    await p.close();
  },
  async reopen() {
    // Start a turn on desktop, close the tab, open on the phone mid-turn and see it stream.
    const a = await page(desktop, session);
    await send(a, "Count from 1 to 40, one number per line, no other text.");
    await a.waitForFunction(() => /\b3\b/.test([...document.querySelectorAll(".t-msg.assistant")].at(-1)?.innerText ?? ""), null, { timeout: 60_000 });
    await a.close();
    const b = await page(phone, session);
    await running(b, 15_000).catch(() => console.log("    (the turn ended before the phone opened)"));
    await idle(b);
    await b.waitForFunction(() => /\b40\b/.test(document.body.innerText), null, { timeout: 30_000 });
    const c = await page(desktop, session);
    await idle(c);
    await c.waitForFunction(() => /\b40\b/.test(document.body.innerText), null, { timeout: 30_000 });
    if ((await transcriptText(b)) !== (await transcriptText(c))) fail("phone and reopened desktop differ after the turn");
    ok("closed the desktop tab mid-turn; the phone picked it up and both match after");
    await b.close();
    await c.close();
  },
  async subagent() {
    const p = await page(desktop, session);
    await send(p, "Use the Agent tool (general-purpose subagent) to run `wc -l README.md math.ts` with Bash and report back. Then tell me the total in one sentence.");
    const link = p.locator(".t-tool .t-link").first();
    await link.waitFor({ timeout: 120_000 });
    await shot(p, "subagent-parent");
    await link.click();
    await p.waitForURL(/%2F|\//, { timeout: 10_000 });
    await p.locator(".t-tool").first().waitFor({ timeout: 60_000 });
    const t = await transcriptText(p);
    if (!/wc -l/.test(t)) fail("child view lacks the Bash call");
    await shot(p, "subagent-child");
    ok(`opened the subagent's own view (${p.url().split("#")[1]})`);
    await p.goBack();
    await idle(p, 180_000);
    await p.close();
  },
  async restart() {
    if (!RESTART) return console.log("skip restart (set RESTART_RUNNER)");
    const p = await page(desktop, session);
    await send(p, "Count from 1 to 60, one number per line, no other text.");
    await p.waitForFunction(() => /\b5\b/.test([...document.querySelectorAll(".t-msg.assistant")].at(-1)?.innerText ?? ""), null, { timeout: 60_000 });
    // Detached, not waited on: the restarted runner outlives this script.
    spawn("bash", ["-c", RESTART], { detached: true, stdio: "ignore" }).unref();
    await p.getByText(/runner restarted/).waitFor({ timeout: 30_000 });
    await idle(p, 30_000);
    await shot(p, "after-restart");
    ok("runner restarted mid-turn: the page resubscribed and says the turn stopped");
    await send(p, "Reply with the word 'continued' only.");
    await p.waitForFunction(() => /continued/i.test([...document.querySelectorAll(".t-msg.assistant")].at(-1)?.innerText ?? ""), null, { timeout: 90_000 });
    ok("the next message continues the same session");
    await p.close();
  },
  async paging() {
    if (!LONG) return console.log("skip paging (set LONG_SESSION)");
    const p = await page(phone, `${BASE}/#/s/tether-dev/${encodeURIComponent(LONG)}`);
    await p.locator(".t-msg").first().waitFor({ timeout: 30_000 });
    const ids = new Set();
    const collect = async () => (await p.$$eval("[data-id]", (els) => els.map((e) => e.getAttribute("data-id")))).forEach((i) => ids.add(i));
    await collect();
    const first = ids.size;
    for (let i = 0; i < 40; i++) {
      await p.locator(".t-scroll").evaluate((e) => (e.scrollTop = 0));
      await p.waitForTimeout(250);
      await collect();
    }
    const dom = await p.locator("[data-id]").count();
    if (ids.size <= first + 50) fail(`paging loaded too little: ${first} -> ${ids.size}`);
    await shot(p, "paging-phone");
    ok(`paged a long session on the phone: saw ${ids.size} messages, ${dom} in the DOM at once`);
    await p.close();
  },
  async layout() {
    const p = await page(phone);
    await noOverflow(p, "phone home");
    await shot(p, "phone-home");
    const d = await page(desktop);
    await shot(d, "desktop-home");
    ok("home pages lay out without sideways scroll");
  },
};

const pick = process.argv.slice(2);
try {
  for (const name of pick.length ? pick : ["new", "stream", "twodev", "interrupt", "reopen", "subagent", "restart", "paging", "layout"]) {
    if (!session && !["new", "paging", "layout"].includes(name) && process.env.SESSION) session = `${BASE}/#/s/tether-dev/${encodeURIComponent(process.env.SESSION)}`;
    console.log(`\n== ${name}`);
    await steps[name]();
  }
  if (errors.length) fail(`page errors:\n${errors.join("\n")}`);
  console.log("\nall passed");
} finally {
  await browser.close();
}
