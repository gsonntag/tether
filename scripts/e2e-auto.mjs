// The billing chip's plan lines and the switch when the plan runs out (SPEC §10), in a real browser
// on scripts/limit-runner.ts, at desktop (1280) and phone (375):
//   BASE=http://127.0.0.1:5299 RUNNER=tether-dev-auto SHOTS=<dir> node scripts/e2e-auto.mjs
const { chromium } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const BASE = process.env.BASE ?? "http://127.0.0.1:5299";
const RUNNER = process.env.RUNNER ?? "tether-dev-auto";
const SHOTS = process.env.SHOTS ?? "/tmp/claude-1001/auto/shots";
const browser = await chromium.launch();
const errors = [];
const ok = (m) => console.log(`ok  ${m}`);
const fail = (m) => { throw new Error(m); };
const want = (c, m) => (c ? ok(m) : fail(m));
const url = (id) => `${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`;
const open = async (ctx, id) => {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(url(id));
  await p.locator(".t-header").waitFor();
  await p.locator(".t-source-chip").waitFor();
  return p;
};
const shot = (p, name) => p.screenshot({ path: `${SHOTS}/${name}.png` });
const chip = (p) => p.locator(".t-source-chip").first();
const menu = async (p) => {
  await chip(p).click();
  await p.getByRole("menu").first().waitFor();
  await p.waitForTimeout(400);
};
const close = (p) => p.keyboard.press("Escape");
const box = (p) => p.getByRole("menuitemcheckbox");
const send = async (p, text) => {
  await p.locator("textarea.t-input[aria-label=Message]").fill(text);
  await p.locator('button[aria-label="Send"]').click();
};
const until = async (p, text, ms = 15000) => p.getByText(text).first().waitFor({ timeout: ms });
const lines = (p) => p.locator(".t-plan-line").allTextContents();

const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

// Claude, plan: nothing reported yet, then a report.
{
  const p = await open(desktop, "claude:plan-a");
  await menu(p);
  want((await lines(p)).length === 0, "nothing reported: no plan lines, no made-up number");
  want(await box(p).count() === 1, "a plan session with a key has the box");
  want((await box(p).getAttribute("aria-checked")) === "false", "off by default");
  await close(p);
  await send(p, "hello");
  await until(p, "on the plan");
  await menu(p);
  const l = await lines(p);
  want(l.length === 2 && /^Week 64% · resets /.test(l[0]) && /^5 hours 12% · resets /.test(l[1]), `the windows reported: ${l.join(" / ")}`);
  await box(p).click();
  await p.waitForTimeout(500);
  want(await box(p).isVisible(), "the menu stays open on a toggle");
  want((await box(p).getAttribute("aria-checked")) === "true", "ticked");
  await shot(p, "desktop-plan-menu");
  await close(p);
  await p.reload();
  await chip(p).waitFor();
  await menu(p);
  want((await box(p).getAttribute("aria-checked")) === "true", "still ticked after a reload (saved in prefs)");
  await close(p);
  want(/Week 64%/.test(await chip(p).textContent()), "the chip keeps its plan %");

  await send(p, "please limit me");
  await until(p, "Plan limit reached. Switched to Anthropic API key.");
  await until(p, "on the key");
  await p.locator(".t-paid-badge").first().waitFor();
  const n = await p.locator(".t-msg.notice", { hasText: "Plan limit reached" }).count();
  want(n === 1, "one notice");
  const t = await p.locator(".t-msg.notice", { hasText: "Plan limit reached" }).first().textContent();
  want(/Resending your message\. Plan resets /.test(t), `the notice: ${t}`);
  want(await p.locator(".t-msg.user", { hasText: "please limit me" }).count() === 2, "the same message, once more");
  await shot(p, "desktop-switched");
  await menu(p);
  const kl = await lines(p);
  want(kl.length === 2, "the key session still sees the plan's lines");
  want(await p.getByRole("menu").first().getByText("Claude plan", { exact: true }).count() >= 1, "under the plan's name");
  want(await box(p).count() === 0, "no box on a key");
  await shot(p, "desktop-key-menu");
  await close(p);
  want(!/\d+%/.test(await chip(p).textContent()), "no plan % on the key's chip");
  await send(p, "still here");
  await p.waitForTimeout(1200);
  want((await p.locator(".t-paid-badge").count()) > 0, "it stays on the key");
  await p.close();
}

// Tools already ran: switched, not resent.
{
  const p = await open(desktop, "claude:plan-b");
  await menu(p);
  await box(p).click();
  await p.waitForTimeout(300);
  await close(p);
  await send(p, "tools limit");
  await until(p, "Tools had already run in that turn");
  await p.waitForTimeout(800);
  want(await p.locator(".t-msg.user", { hasText: "tools limit" }).count() === 1, "tools ran: not resent");
  await p.locator(".t-next-source").waitFor();
  await shot(p, "desktop-tools-ran");
  await p.close();
}

// A short 429 with the box ticked: nothing switches.
{
  const p = await open(desktop, "claude:plan-c");
  await menu(p);
  await box(p).click();
  await p.waitForTimeout(300);
  await close(p);
  await send(p, "short 429");
  await until(p, "temporarily limiting");
  await p.waitForTimeout(1000);
  want(await p.locator(".t-paid-badge").count() === 0 && await p.locator(".t-next-source").count() === 0, "a short 429 changes nothing");
  await p.close();
}

// Phone, Codex: both keys, the cheap read, the stale figure, the carry.
{
  const p = await open(phone, "codex:codex-a");
  await chip(p).tap();
  await p.getByRole("menu").first().waitFor();
  await p.waitForTimeout(800);
  const reads = await lines(p);
  want(reads.length === 2 && reads.every((l) => l.endsWith("· 3h ago")), `a stale figure says how old: ${reads.join(" / ")}`);
  await shot(p, "phone-codex-menu");
  const b = await p.getByRole("menu").first().boundingBox();
  want(b.x >= 0 && b.x + b.width <= 375, `the menu fits at 375 (${Math.round(b.x)}..${Math.round(b.x + b.width)})`);
  want(/OpenAI API key/.test(await box(p).textContent()), "both keys: the target is named, OpenAI by default");
  await p.getByRole("menuitemradio", { name: /Azure/ }).tap();
  await p.waitForTimeout(600);
  await close(p).catch(() => {});
  await p.locator(".t-next-source").waitFor();
  await p.waitForTimeout(300);
  await chip(p).tap();
  await p.waitForTimeout(500);
  await p.getByRole("menuitemradio", { name: /ChatGPT plan/ }).tap();
  await p.waitForTimeout(600);
  await close(p).catch(() => {});
  await chip(p).tap();
  await p.getByRole("menu").first().waitFor();
  await p.waitForTimeout(800);
  want(/Azure/.test(await box(p).textContent()), "the last key picked is the target");
  const fresh = await lines(p);
  want(fresh.length === 2 && !fresh.some((l) => l.includes("ago")) && fresh[0] !== reads[0], `opening the menu reads again: ${fresh.join(" / ")}`);
  await box(p).tap();
  await p.waitForTimeout(400);
  want((await box(p).getAttribute("aria-checked")) === "true" && await box(p).isVisible(), "ticked on a phone, menu open");
  await shot(p, "phone-codex-ticked");
  await close(p).catch(() => {});
  await p.mouse.click(10, 500).catch(() => {});
  await send(p, "limit please");
  await until(p, "on Azure", 20000);
  await p.waitForTimeout(500);
  await shot(p, "phone-carried");
  want(await p.locator(".t-paid-badge").first().isVisible(), "the loud badge on Azure, at 375");
  await until(p, "Plan limit reached. Switched to Azure.");
  ok("the notice crossed the carry");
  await p.close();
}

// No key: no box.
{
  const p = await open(desktop, "claude:plan-c");
  const unset = await p.evaluate(async (r) => {
    const name = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/connection.ts"));
    const { rpc } = await import(name);
    await rpc(r, "unsetCredential", { source: "anthropic" });
    return true;
  }, RUNNER);
  await menu(p);
  want(unset && await box(p).count() === 0, "no key set: no box");
  await shot(p, "desktop-no-key");
  await p.close();
}

await browser.close();
if (errors.length) fail(`page errors: ${errors.join("; ")}`);
console.log("all ok");
