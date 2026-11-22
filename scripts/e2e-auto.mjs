// The billing chip's plan lines and the fallback chain (SPEC §10), in a real browser
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
const chain = (p) => p.getByRole("button", { name: /^Fallback chain ·/ });
const editor = async (p) => {
  await chain(p).click();
  const dialog = p.getByRole("dialog", { name: "Fallback chain" });
  await dialog.getByRole("button", { name: "Add step" }).waitFor();
  return dialog;
};
const enabled = (dialog) => dialog.getByRole("checkbox", { name: "Enable for this session" });
const save = async (dialog) => {
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
};
const configure = async (p, harness, source, model) => {
  const dialog = await editor(p);
  while (await dialog.getByRole("button", { name: /^Remove step/ }).count()) {
    // The accessible index changes after each removal.
    await dialog.getByRole("button", { name: /^Remove step/ }).first().click();
  }
  await dialog.getByRole("button", { name: "Add step" }).click();
  await dialog.getByLabel("Harness", { exact: true }).selectOption(harness);
  await dialog.getByLabel("Login or key", { exact: true }).selectOption(source);
  await dialog.getByLabel("Model", { exact: true }).selectOption(model);
  await enabled(dialog).check();
  return dialog;
};
const send = async (p, text) => {
  await p.locator("textarea.t-input[aria-label=Message]").fill(text);
  await p.locator('button[aria-label="Send"]').click();
};
const until = async (p, text, ms = 15000) => p.getByText(text).first().waitFor({ timeout: ms });
// The plan's windows only (the API cost group's lines, "Cost unknown", share the class).
const lines = async (p) => (await p.locator(".t-plan-line").allTextContents()).filter((l) => /^(Week|5 hours) /.test(l));

const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

// Claude, plan: nothing reported yet, then a report.
{
  const p = await open(desktop, "claude:plan-a");
  await menu(p);
  want((await lines(p)).length === 0, "nothing reported: no plan lines, no made-up number");
  want((await chain(p).textContent()).includes("Off"), "off by default");
  await close(p);
  await send(p, "hello");
  await until(p, "on the plan");
  await menu(p);
  const l = await lines(p);
  want(l.length === 2 && /^Week 64% · resets /.test(l[0]) && /^5 hours 12% · resets /.test(l[1]), `the windows reported: ${l.join(" / ")}`);
  await close(p);
  const dialog = await configure(p, "claude", "anthropic", "claude-haiku-5-5");
  await dialog.getByLabel("Preset name").fill("Claude backup");
  await dialog.getByRole("button", { name: "Save as preset" }).click();
  await dialog.getByRole("button", { name: "Rename" }).waitFor();
  await dialog.getByLabel("Preset name").fill("Claude backup renamed");
  await dialog.getByRole("button", { name: "Rename" }).click();
  await dialog.getByRole("option", { name: "Claude backup renamed" }).waitFor({ state: "attached" });
  await save(dialog);
  await p.reload();
  await chip(p).waitFor();
  const saved = await editor(p);
  want(await enabled(saved).isChecked(), "enabled and saved across reload");
  await saved.getByLabel("Runner presets").selectOption({ label: "Claude backup renamed" });
  await saved.getByRole("button", { name: "Load preset" }).click();
  want(await saved.getByLabel("Model", { exact: true }).inputValue() === "claude-haiku-5-5", "runner preset loads the saved order");
  await saved.getByRole("button", { name: "Delete" }).click();
  await saved.getByRole("option", { name: "Claude backup renamed" }).waitFor({ state: "detached" });
  await save(saved);
  want(/5h 12%/.test(await chip(p).textContent()), "the chip keeps its plan %");

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
  want(await p.getByRole("menuitemcheckbox").count() === 0, "the legacy billing toggle is gone");
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
  await save(await configure(p, "claude", "anthropic", "claude-haiku-5-5"));
  await send(p, "tools limit");
  await until(p, "The turn already acted.");
  await p.waitForTimeout(800);
  want(await p.locator(".t-msg.user", { hasText: "tools limit" }).count() === 1, "tools ran: not resent");
  // Idle, the header shows the source the next turn uses (a Next chip only while work runs).
  await p.locator(".t-paid-badge").first().waitFor();
  want(await p.locator(".t-next-source").count() === 0, "idle: the key is the badge, no Next chip");
  await shot(p, "desktop-tools-ran");
  await p.close();
}

// A short 429 while Tether is still retrying: no switch yet.
{
  const p = await open(desktop, "claude:plan-c");
  await save(await configure(p, "claude", "anthropic", "claude-haiku-5-5"));
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
  await close(p);
  const dialog = await configure(p, "codex", "azure", "fake-deployment");
  const bounds = await dialog.boundingBox();
  want(bounds.x >= 0 && bounds.x + bounds.width <= 375, "fallback editor fits at 375px");
  await shot(p, "phone-fallback-editor");
  await save(dialog);
  await send(p, "limit please");
  await until(p, "on Azure", 20000);
  await p.waitForTimeout(500);
  await shot(p, "phone-carried");
  want(await p.locator(".t-paid-badge").first().isVisible(), "the loud badge on Azure, at 375");
  await until(p, "Plan limit reached. Next source: Azure.");
  await p.getByRole("button", { name: "Fallback chain · 1/1 · Codex" }).waitFor();
  ok("the notice and chain progress crossed the carry");
  await p.close();
}

// Removing a key shows the reason on the saved step.
{
  const p = await open(desktop, "claude:plan-c");
  await p.evaluate(async (r) => {
    const name = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/connection.ts"));
    const { rpc } = await import(name);
    await rpc(r, "unsetCredential", { source: "anthropic" });
  }, RUNNER);
  const dialog = await editor(p);
  await dialog.getByText("Login or key unavailable.").waitFor();
  await enabled(dialog).uncheck();
  await save(dialog);
  await p.getByRole("button", { name: "Fallback chain · Off" }).waitFor();
  await p.close();
}

await browser.close();
if (errors.length) fail(`page errors: ${errors.join("; ")}`);
console.log("all ok");
