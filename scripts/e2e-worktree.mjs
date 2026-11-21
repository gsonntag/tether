// A worktree per session (SPEC §4) end to end against a local dev stack and REAL Claude (Haiku),
// desktop and phone: New worktree, then Existing worktree on the one it made.
//   PLAYWRIGHT=/path/to/playwright/index.mjs REPO=/tmp/repo/app BAD_REPO=/tmp/repo/bad PLAIN=/tmp/plain node scripts/e2e-worktree.mjs
// REPO: a git repo whose .tether/setup takes a few seconds; BAD_REPO: one whose setup fails;
// PLAIN: a folder outside git. Three Haiku turns in all. Screenshots go to $SHOTS.

import { mkdirSync } from "node:fs";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const BASE = process.env.BASE ?? "http://127.0.0.1:5180";
const SHOTS = process.env.SHOTS ?? "/tmp/tether-e2e-worktree";
const REPO = process.env.REPO;
const BAD = process.env.BAD_REPO;
const PLAIN = process.env.PLAIN;
if (!REPO || !BAD || !PLAIN) throw new Error("set REPO, BAD_REPO and PLAIN");
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
const errors = [];
const page = async (ctx, url = BASE) => {
  const p = await ctx.newPage();
  // Cheap turns: Haiku at low effort (the dialog has no effort field).
  await p.addInitScript(() => {
    const original = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string") {
        try {
          const m = JSON.parse(data);
          if (m.t === "rpc" && (m.op === "newSession" || m.op === "newWorktreeSession" || m.op === "existingWorktreeSession") && m.args?.model === "haiku") {
            m.args.effort = "low";
            return original.call(this, JSON.stringify(m));
          }
        } catch {}
      }
      return original.call(this, data);
    };
  });
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(url);
  return p;
};
const shot = (p, name) => p.screenshot({ path: `${SHOTS}/${name}.png` });
const ok = (msg) => console.log(`ok  ${msg}`);
const fail = (msg) => {
  throw new Error(msg);
};
const noOverflow = async (p, where) => {
  const w = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (w > 1) fail(`${where}: page scrolls sideways by ${w}px`);
};
const composer = (p) => p.locator("textarea.t-input");
/** Existing worktree's picker shows each entry's whole label (its "used by N" end isn't cut off). */
const labelsWhole = async (p, where) => {
  const cut = await p.locator('[role=listbox][aria-label=Worktrees] .t-path').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1).map((e) => e.textContent));
  if (cut.length) fail(`${where}: worktree labels cut off: ${cut.join("; ")}`);
};

/** New session in `repo`, New worktree, Haiku, bypass: the session's URL. */
async function create(p, repo, name) {
  await p.getByRole("button", { name: "New session" }).first().click();
  await p.locator("#t-new-path").fill(repo);
  await p.getByRole("radio", { name: "New worktree" }).waitFor({ timeout: 15_000 });
  if ((await p.getByRole("radio", { name: "This folder" }).getAttribute("aria-checked")) !== "true") fail("This folder isn't the default");
  await p.getByRole("radio", { name: "New worktree" }).click();
  const branch = p.locator('input[placeholder^="tether/"]');
  await branch.waitFor();
  await p.getByText(/A new folder beside the repo, from main/).waitFor();
  if (name) await branch.fill(name);
  const selects = p.locator(".t-form select.t-select");
  await p.waitForFunction(() => [...document.querySelectorAll(".t-form select option")].some((o) => o.value === "haiku"), null, { timeout: 30_000 });
  await selects.nth(0).selectOption("haiku");
  await selects.nth(1).selectOption("bypassPermissions");
  await shot(p, `dialog-${(name ?? "default").replace(/\//g, "-")}`);
  await p.getByRole("button", { name: "Create", exact: true }).click();
  await p.waitForURL(/#\/s\//, { timeout: 60_000 });
  return p.url();
}

// Desktop: the setup runs as a card, the first message waits for it, then runs in the worktree.
const d = await page(desktop);
const slug = `e2e-${Date.now().toString(36)}`;
const url = await create(d, REPO, `tether/${slug}`);
await d.locator(".t-shellcard-who", { hasText: "Worktree setup" }).waitFor({ timeout: 15_000 });
await composer(d).fill("Run the shell command pwd and reply with only its output.");
await composer(d).press("Enter");
await d.getByText("Waiting for the worktree's setup to finish.").waitFor({ timeout: 5_000 });
await shot(d, "desktop-setup-running");
ok("setup card running, first message held");
await d.getByText("Setup done").waitFor({ timeout: 30_000 });
const wt = `${REPO}-worktrees/${slug}`;
await d.getByText(wt, { exact: true }).first().waitFor(); // the header's folder
await d.locator(".t-msg.assistant", { hasText: wt }).first().waitFor({ timeout: 120_000 });
await shot(d, "desktop-ran-in-worktree");
await noOverflow(d, "desktop session");
ok(`the first message went after the setup, and ran in ${wt}`);

// Existing worktree: a second session joins the worktree the first one made.
const createBtn = (p) => p.getByRole("button", { name: "Create", exact: true });
const disabled = (p) => createBtn(p).evaluate((b) => b.disabled || b.getAttribute("aria-disabled") === "true");
const j = await page(desktop);
await j.getByRole("button", { name: "New session" }).first().click();
await j.locator("#t-new-path").fill(REPO);
await j.getByRole("radio", { name: "Existing worktree" }).click({ timeout: 15_000 });
const label = `${wt} · tether/${slug} · used by 1 session`;
await j.getByRole("listbox", { name: "Worktrees" }).getByRole("option").filter({ hasText: label }).waitFor({ timeout: 15_000 });
if (!(await disabled(j))) fail("Create is enabled before a worktree is picked");
await labelsWhole(j, "desktop");
await shot(j, "existing-desktop-list");
ok(`the picker lists ${label}`);
// A path change: Create waits for the new folder's info, and a repo with none says so.
await j.locator("#t-new-path").fill(BAD);
if (!(await disabled(j))) fail("Create is enabled right after a path change");
// (BAD_REPO has no worktrees on a first run; the bad session below makes one.)
await j.locator('.t-ws-note:has-text("no worktrees besides"), [role=listbox][aria-label=Worktrees] [role=option]:has-text("bad-worktrees")').first().waitFor({ timeout: 15_000 });
if (!(await disabled(j))) fail("Create is enabled with no worktree picked");
await shot(j, "existing-desktop-other-repo");
ok("Create waits for the folder's info, and for a pick in another repo");
// Outside git: no Workspace choice at all.
await j.locator("#t-new-path").fill(PLAIN);
if (!(await disabled(j))) fail("Create is enabled right after a path change (outside git)");
await j.waitForFunction(() => {
  const b = [...document.querySelectorAll("button")].find((e) => e.textContent?.trim() === "Create");
  return b && !b.disabled && b.getAttribute("aria-disabled") !== "true";
}, null, { timeout: 15_000 });
if (await j.getByRole("radiogroup", { name: "Workspace" }).count()) fail("a folder outside git offers a Workspace choice");
await shot(j, "existing-desktop-plain");
ok("a folder outside git offers no Workspace choice");
// New worktree, then another repo typed: Create stays off until that folder's info is in (else
// it would start in the folder itself). Sampled every frame.
await j.locator("#t-new-path").fill(REPO);
await j.getByRole("radio", { name: "New worktree" }).click({ timeout: 15_000 });
await j.locator('input[placeholder^="tether/"]').waitFor();
await j.evaluate(() => {
  const w = globalThis;
  w.__bad = [];
  w.__sampling = true;
  const tick = () => {
    const b = [...document.querySelectorAll("button")].find((e) => e.textContent?.trim() === "Create");
    const on = b && !b.disabled && b.getAttribute("aria-disabled") !== "true";
    if (on && !document.querySelector('input[placeholder^="tether/"]')) w.__bad.push(document.querySelector("#t-new-path")?.value);
    if (w.__sampling) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await j.locator("#t-new-path").fill(BAD);
await j.waitForFunction(() => {
  const b = [...document.querySelectorAll("button")].find((e) => e.textContent?.trim() === "Create");
  return b && !b.disabled && b.getAttribute("aria-disabled") !== "true";
}, null, { timeout: 15_000 });
const bad = await j.evaluate(() => ((globalThis.__sampling = false), globalThis.__bad));
if (bad.length) fail(`Create was enabled without the worktree fields, for ${bad.length} frames`);
ok("New worktree: Create stays off while the new folder's info loads");
await j.getByRole("radio", { name: "Existing worktree" }).click();

// Back to the repo: pick it and Create.
await j.locator("#t-new-path").fill(REPO);
if (!(await disabled(j))) fail("Create is enabled right after a path change (back)");
const opt = j.getByRole("listbox", { name: "Worktrees" }).getByRole("option").filter({ hasText: wt });
await opt.click({ timeout: 15_000 });
await j.getByText(/Tether made this one/).waitFor();
const sel = j.locator(".t-form select.t-select");
await j.waitForFunction(() => [...document.querySelectorAll(".t-form select option")].some((o) => o.value === "haiku"), null, { timeout: 30_000 });
await sel.nth(0).selectOption("haiku");
await sel.nth(1).selectOption("bypassPermissions");
if (await disabled(j)) fail("Create is disabled with a worktree picked");
await shot(j, "existing-desktop-picked");
await noOverflow(j, "desktop dialog");
await createBtn(j).click();
await j.waitForURL(/#\/s\//, { timeout: 60_000 });
if (j.url() === url) fail("Existing worktree opened the first session instead of a new one");
await j.getByText(wt, { exact: true }).first().waitFor({ timeout: 15_000 });
if (await j.locator(".t-shellcard-who", { hasText: "Worktree setup" }).count()) fail("a setup ran for an existing worktree");
await composer(j).fill("Run the shell command pwd and reply with only its output.");
await composer(j).press("Enter");
await j.locator(".t-msg.assistant", { hasText: wt }).first().waitFor({ timeout: 120_000 });
await shot(j, "existing-desktop-ran");
ok(`the new session runs in ${wt}, no setup`);
// Both are its users now.
await j.getByRole("button", { name: "New session" }).first().click();
await j.locator("#t-new-path").fill(REPO);
await j.getByRole("radio", { name: "Existing worktree" }).click({ timeout: 15_000 });
await j.getByRole("listbox", { name: "Worktrees" }).getByRole("option").filter({ hasText: `${wt} · tether/${slug} · used by 2 sessions` }).waitFor({ timeout: 15_000 });
await j.keyboard.press("Escape");
ok("the worktree is used by 2 sessions");

// Phone: the same session, and the dialog's Workspace choice.
const m = await page(phone, url);
await m.locator(".t-shellcard-who", { hasText: "Worktree setup" }).waitFor({ timeout: 15_000 });
await shot(m, "phone-session");
await noOverflow(m, "phone session");
await m.goto(BASE);
// (New session is in the phone's navigation drawer: opened through the page's store.)
await m.waitForFunction(() => !!globalThis.__tetherStore);
await m.evaluate(() => globalThis.__tetherStore.setState({ newSessionOpen: true }));
await m.locator("#t-new-path").fill(REPO);
await m.getByRole("radio", { name: "New worktree" }).click({ timeout: 15_000 });
await m.locator('input[placeholder^="tether/"]').waitFor();
await shot(m, "phone-dialog");
await noOverflow(m, "phone dialog");
await m.getByRole("radio", { name: "Existing worktree" }).click();
await m.getByRole("listbox", { name: "Worktrees" }).getByRole("option").filter({ hasText: wt }).click({ timeout: 15_000 });
await m.getByText(/Tether made this one/).waitFor();
await labelsWhole(m, "phone");
await shot(m, "phone-dialog-existing");
await noOverflow(m, "phone dialog (Existing worktree)");
await m.keyboard.press("Escape");
ok("phone: session and dialog fit");

// A failing setup: shown, the message stays held, Send anyway lets it go.
const b = await page(desktop);
await create(b, BAD);
await composer(b).fill("Reply with just the word ok.");
await composer(b).press("Enter");
await b.getByText(/Setup failed/).first().waitFor({ timeout: 20_000 });
await b.getByText("npm ERR! missing package.json").first().waitFor();
await b.getByText("Held: the worktree's setup failed. Fix it, or send it anyway.").waitFor();
await shot(b, "desktop-setup-failed");
ok("failed setup shown, message held");
await b.getByRole("button", { name: "Send anyway" }).first().click();
await b.locator(".t-msg.assistant").first().waitFor({ timeout: 120_000 });
await shot(b, "desktop-sent-anyway");
ok("Send anyway sent it");

if (errors.length) fail(`page errors: ${errors.join("; ")}`);
await browser.close();
