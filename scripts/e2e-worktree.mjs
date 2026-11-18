// A worktree per session (SPEC §4) end to end against a local dev stack and REAL Claude (Haiku),
// desktop and phone:
//   PLAYWRIGHT=/path/to/playwright/index.mjs REPO=/tmp/repo/app BAD_REPO=/tmp/repo/bad node scripts/e2e-worktree.mjs
// REPO: a git repo whose .tether/setup takes a few seconds; BAD_REPO: one whose setup fails.
// Two Haiku turns in all. Screenshots go to $SHOTS.

import { mkdirSync } from "node:fs";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const BASE = process.env.BASE ?? "http://127.0.0.1:5180";
const SHOTS = process.env.SHOTS ?? "/tmp/tether-e2e-worktree";
const REPO = process.env.REPO;
const BAD = process.env.BAD_REPO;
if (!REPO || !BAD) throw new Error("set REPO and BAD_REPO");
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
          if (m.t === "rpc" && (m.op === "newSession" || m.op === "newWorktreeSession") && m.args?.model === "haiku") {
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
await d.getByText(`Setting up tether/${slug} in ${wt}`).first().waitFor();
await d.locator(".t-msg.assistant", { hasText: wt }).first().waitFor({ timeout: 120_000 });
await shot(d, "desktop-ran-in-worktree");
await noOverflow(d, "desktop session");
ok(`the first message went after the setup, and ran in ${wt}`);

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
await b.getByRole("button", { name: "Send anyway" }).click();
await b.locator(".t-msg.assistant").first().waitFor({ timeout: 120_000 });
await shot(b, "desktop-sent-anyway");
ok("Send anyway sent it");

if (errors.length) fail(`page errors: ${errors.join("; ")}`);
await browser.close();
