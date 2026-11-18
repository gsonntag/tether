// Scheduled sends (SPEC §9) end to end against a local dev stack and REAL Claude (Haiku), desktop
// (New York time) and phone (Los Angeles time):
//   PLAYWRIGHT=/path/to/playwright/index.mjs node scripts/e2e-scheduled.mjs [all|due|restart|edit|phone]
// Needs: the server, the dev runner and vite running (README "Development"). Env:
//   BASE         the web app (default http://127.0.0.1:5180)
//   SCRATCH      a folder for the new session (default ~/.local/share/tether-dev/projects/scratch)
//   STOP_RUNNER  a shell command that stops the dev runner (the `restart` step)
//   START_RUNNER a shell command that starts it again
//   SESSION      the hash URL of an existing session to use instead of making one
//   SHOTS        where screenshots go (default /tmp/tether-e2e-scheduled)
// It waits ~2 min for an on-time send and ~4 min with the runner off; a handful of Haiku turns.
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
const { chromium } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const BASE = process.env.BASE ?? "http://127.0.0.1:5180";
const SHOTS = process.env.SHOTS ?? "/tmp/tether-e2e-scheduled";
const SCRATCH = process.env.SCRATCH ?? `${process.env.HOME}/.local/share/tether-dev/projects/scratch`;
const STOP_RUNNER = process.env.STOP_RUNNER;
const START_RUNNER = process.env.START_RUNNER;
mkdirSync(SHOTS, { recursive: true });
const step = process.argv[2] ?? "all";

async function cheap(page) {
  await page.addInitScript(() => {
    const original = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string") {
        try { const m = JSON.parse(data); if (m.t === "rpc" && m.op === "newSession" && m.args?.model === "haiku") { m.args.effort = "low"; return original.call(this, JSON.stringify(m)); } } catch {}
      }
      return original.call(this, data);
    };
  });
}
const browser = await chromium.launch();
const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: "America/New_York" });
const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, timezoneId: "America/Los_Angeles" });
const errors = [];
const open = async (ctx, url = BASE) => {
  const p = await ctx.newPage();
  await cheap(p);
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(url);
  return p;
};
const shot = (p, n) => p.screenshot({ path: `${SHOTS}/${n}.png` });
const ok = (m) => console.log(`ok  ${new Date().toISOString().slice(11, 19)} ${m}`);
const fail = (m) => { throw new Error(m); };
const box = (p) => p.locator("textarea.t-input[aria-label=Message]");
const idle = (p, ms = 120_000) => p.locator('button[aria-label="Send"]').waitFor({ timeout: ms });
const local = (p, ms) => p.evaluate((ms) => { const d = new Date(Date.now() + ms); d.setSeconds(0, 0); const z = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; }, ms);
const texts = (p) => p.evaluate(() => JSON.stringify(Object.values(globalThis.__tetherStore.getState().views).map((v) => v.window.messages)));

async function scheduleCustom(p, text, inMs) {
  await box(p).fill(text);
  await p.locator('button[aria-label="More ways to send"]').click();
  await p.getByRole("menuitem", { name: /Send later/ }).click();
  await p.locator(".t-send-later").waitFor();
  const when = await local(p, inMs);
  await p.locator('.t-send-later input[aria-label="Send at"]').fill(when);
  await p.locator(".t-send-later").getByRole("button", { name: "Schedule" }).click();
  await p.locator(".t-scheduled", { hasText: text }).waitFor({ timeout: 10_000 });
  if ((await box(p).inputValue()) !== "") fail("the box kept the text");
  return when;
}

let session = process.env.SESSION;
if (!session) {
  const p = await open(desktop);
  await p.getByRole("button", { name: "New session" }).first().click();
  await p.locator("#t-new-path").fill(SCRATCH);
  const selects = p.locator(".t-form select.t-select");
  await p.waitForFunction(() => [...document.querySelectorAll(".t-form select option")].some((o) => o.value === "haiku"), null, { timeout: 30_000 });
  await selects.nth(0).selectOption("haiku");
  await selects.nth(1).selectOption("bypassPermissions");
  await p.getByRole("button", { name: "Create", exact: true }).click();
  await p.waitForURL(/#\/s\//, { timeout: 60_000 });
  session = p.url();
  await box(p).fill("Reply with just: ready");
  await box(p).press("Enter");
  await p.locator(".t-msg.assistant").first().waitFor({ timeout: 90_000 });
  await idle(p);
  ok(`session ${decodeURIComponent(session.split("#")[1])}`);
  await p.close();
}
console.log("SESSION=" + session);

if (step === "all" || step === "due") {
  const p = await open(desktop, session);
  await box(p).waitFor();
  await box(p).fill("Reply with just the word: alpha");
  await p.locator('button[aria-label="More ways to send"]').click();
  await shot(p, "1-menu");
  await p.getByRole("menuitem", { name: /Send later/ }).click();
  await p.locator(".t-send-later").waitFor();
  await shot(p, "2-picker");
  const presets = await p.locator(".t-send-later-presets button").allInnerTexts();
  ok(`presets: ${presets.join(" | ")}`);
  await p.keyboard.press("Escape");
  if (await p.locator(".t-send-later").count()) fail("Esc left the picker open");
  // Alt+Enter opens it too.
  await box(p).press("Alt+Enter");
  await p.locator(".t-send-later").waitFor();
  await p.keyboard.press("Escape");
  await box(p).fill("");
  const when = await scheduleCustom(p, "Reply with just the word: alpha", 2 * 60_000);
  const label = await p.locator(".t-scheduled .t-scheduled-when").first().innerText();
  ok(`scheduled for ${when} (NY): "${label}"`);
  await shot(p, "3-scheduled");
  await p.locator(".t-scheduled").waitFor({ state: "detached", timeout: 200_000 });
  ok("left the queue at its time");
  await p.waitForFunction(() => JSON.stringify(Object.values(globalThis.__tetherStore.getState().views).map((v) => v.window.messages)).toLowerCase().includes("alpha"), null, { timeout: 60_000 });
  await idle(p);
  const t = await texts(p);
  if (/sent late/.test(t)) fail("on-time send marked late");
  ok("sent on time, Claude answered, no late notice");
  await shot(p, "4-sent");
  await p.close();
}

if (step === "all" || step === "restart") {
  const p = await open(desktop, session);
  await box(p).waitFor();
  const when = await scheduleCustom(p, "Reply with just the word: bravo", 60_000);
  ok(`bravo scheduled for ${when}`);
  if (!STOP_RUNNER || !START_RUNNER) fail("set STOP_RUNNER and START_RUNNER for the restart step");
  execSync(STOP_RUNNER);
  ok("runner stopped");
  // Past its time by over two minutes, then start again.
  await p.waitForTimeout(4 * 60_000);
  execSync(START_RUNNER);
  ok("runner started");
  await p.waitForFunction(() => JSON.stringify(Object.values(globalThis.__tetherStore.getState().views).map((v) => v.window.messages)).includes("Scheduled message sent late"), null, { timeout: 120_000 });
  await p.getByText(/Scheduled message sent late\. It was for/).first().waitFor({ timeout: 20_000 });
  const note = await p.getByText(/Scheduled message sent late/).first().innerText();
  ok(`late notice: "${note}"`);
  await p.waitForFunction(() => JSON.stringify(Object.values(globalThis.__tetherStore.getState().views).map((v) => v.window.messages)).toLowerCase().includes("bravo"), null, { timeout: 60_000 });
  await idle(p);
  await shot(p, "5-late");
  await p.close();
}

if (step === "all" || step === "edit") {
  const p = await open(desktop, session);
  await box(p).waitFor();
  await box(p).fill("Reply with just the word: charlie");
  await box(p).press("Alt+Enter");
  await p.locator(".t-send-later").getByRole("button", { name: /^Tomorrow/ }).click();
  const row = p.locator(".t-scheduled");
  await row.waitFor();
  ok(`preset: "${await row.locator(".t-scheduled-when").innerText()}"`);
  await row.getByRole("button", { name: "Edit" }).click();
  await p.locator('textarea[aria-label="Edit the queued message"]').fill("Reply with just the word: charlie2");
  const when = await local(p, 3 * 24 * 3600_000);
  await row.locator('input[aria-label="Send at"]').fill(when);
  await shot(p, "6-edit");
  await row.getByRole("button", { name: "Save" }).click();
  await p.locator(".t-scheduled", { hasText: "charlie2" }).waitFor();
  const label = await p.locator(".t-scheduled .t-scheduled-when").innerText();
  if (!/Sends \w{3} at/.test(label)) fail(`edited time reads "${label}"`);
  ok(`edited: "${label}"`);
  // Home shows it, not as needing you.
  const h = await open(desktop, BASE);
  const homeRow = h.locator(".t-inbox-row.scheduled").first();
  await homeRow.waitFor({ timeout: 10_000 });
  ok(`Home: "${(await homeRow.innerText()).replace(/\s+/g, " ")}"`);
  await shot(h, "7-home");
  await h.close();
  await p.locator(".t-scheduled").getByRole("button", { name: "Cancel this message" }).click();
  await p.locator(".t-scheduled").waitFor({ state: "detached" });
  ok("cancelled");
  await p.close();
}

if (step === "all" || step === "phone") {
  const p = await open(phone, session);
  await box(p).waitFor();
  await box(p).fill("Reply with just the word: delta");
  await p.locator('button[aria-label="More ways to send"]').click();
  await p.getByRole("menuitem", { name: /Send later/ }).click();
  await p.locator(".t-send-later").waitFor();
  await shot(p, "8-phone-picker");
  const w = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (w > 1) fail(`phone scrolls sideways by ${w}px`);
  await p.locator(".t-send-later").getByRole("button", { name: "In 1 hour" }).click();
  const row = p.locator(".t-scheduled");
  await row.waitFor();
  ok(`phone (LA): "${await row.locator(".t-scheduled-when").innerText()}"`);
  await shot(p, "9-phone-scheduled");
  // Send now from the phone.
  await row.getByRole("button", { name: "Send now" }).click();
  await row.waitFor({ state: "detached", timeout: 20_000 });
  await p.waitForFunction(() => JSON.stringify(Object.values(globalThis.__tetherStore.getState().views).map((v) => v.window.messages)).toLowerCase().includes("delta"), null, { timeout: 60_000 });
  ok("phone: send now went");
  await idle(p);
  await shot(p, "10-phone-sent");
  await p.close();
}

if (errors.length) console.log("page errors:", errors);
await browser.close();
