// Run against scripts/limit-runner.ts through the dev relay (no real model requests): fallback keys,
// Azure deployments changed idle and mid-turn (held as "Next: …"), Other model or deployment…, and the
// Model chip while a source change waits, at 1280 and 375. SHOTS: where screenshots go.
// BASE=http://127.0.0.1:15180 RUNNER=tether-model-fallback-check PROJECT=/tmp/tether-model-fallback-check/project node scripts/e2e-model-fallback.mjs
const { chromium } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const BASE = process.env.BASE ?? "http://127.0.0.1:15180";
const RUNNER = process.env.RUNNER ?? "tether-model-fallback-check";
const PROJECT = process.env.PROJECT ?? "/tmp/tether-model-fallback-check/project";
const SHOTS = process.env.SHOTS ?? "/tmp/claude-1001/pr34fix/shots";
(await import("node:fs")).mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch();
const errors = [];
const want = (condition, message) => { if (!condition) throw new Error(message); console.log(`ok  ${message}`); };
const chip = (p) => p.locator(".t-source-chip").first();
const menu = async (p) => { await chip(p).click(); await p.getByRole("menu").first().waitFor(); };
const rpc = (p, op, args) => p.evaluate(async ({ runner, op, args }) => {
  const name = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/connection.ts"));
  const { rpc } = await import(name);
  return rpc(runner, op, args);
}, { runner: RUNNER, op, args });
const send = async (p, text) => { await p.locator("textarea.t-input[aria-label=Message]").fill(text); await p.locator('button[aria-label="Send"]').click(); };
const fallback = async (p) => { await menu(p); await p.getByRole("menuitem", { name: "Fallback keys…" }).click(); await p.getByRole("dialog").waitFor(); };
const save = async (p) => { await p.getByRole("button", { name: "Save", exact: true }).click(); await p.getByRole("dialog").waitFor({ state: "hidden" }); };
const modelChip = (p) => p.getByRole("button", { name: /^Model:/ });
const pickModel = async (p, name) => {
  await modelChip(p).click();
  await p.getByRole("menuitemradio", { name, exact: true }).click();
};
const chooseModel = async (p, name) => {
  await pickModel(p, name);
  await p.getByRole("button", { name: `Model: ${name}`, exact: true }).waitFor();
};
// Other model or deployment…: the dialog, typed, applied when it's allowed. Returns whether Apply was on.
const typeModel = async (p, text, { apply = true } = {}) => {
  await modelChip(p).click();
  await p.getByRole("menuitem", { name: "Other model or deployment…" }).click();
  const dialog = p.getByRole("dialog");
  await dialog.waitFor();
  await dialog.getByRole("textbox", { name: "Name" }).fill(text);
  const button = dialog.getByRole("button", { name: "Apply" });
  const enabled = await button.isEnabled();
  if (apply && enabled) { await button.click(); await dialog.waitFor({ state: "hidden" }); }
  return { enabled, dialog };
};
const lastNotice = (p) => p.locator(".t-msg.notice").last();
let current;
try {
  for (const width of [1280, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 812 }, hasTouch: width === 375, isMobile: width === 375 });
    const p = await context.newPage();
    current = p;
    p.setDefaultTimeout(10000);
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(`${BASE}/#/s/${encodeURIComponent(RUNNER)}/codex%3Acodex-a`);
    await chip(p).waitFor();
    await rpc(p, "setAzure", { endpoint: "https://fake.invalid", deployments: [{ name: "fake-deployment" }, { name: "deployment-one" }, { name: "deployment-two" }] });
    const { sessionId } = await rpc(p, "newSession", { harness: "codex", projectPath: PROJECT, source: "subscription" });
    await p.goto(`${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(sessionId)}`);
    await chip(p).waitFor();
    await send(p, "hello before fallback");
    await p.getByText(/Fake reply .* on ChatGPT plan/).first().waitFor();
    await fallback(p);
    await p.getByRole("button", { name: "Move Azure up", exact: true }).click();
    want(await p.getByRole("checkbox", { name: "1. Azure", exact: true }).isChecked(), `${width}: Azure ranked first`);
    await p.getByRole("checkbox", { name: "2. OpenAI API key", exact: true }).uncheck();
    await save(p);
    await p.reload();
    await chip(p).waitFor();
    await fallback(p);
    want(await p.getByRole("checkbox", { name: "1. Azure", exact: true }).isChecked(), `${width}: Azure rank survives reload`);
    want(!await p.getByRole("checkbox", { name: "OpenAI API key", exact: true }).isChecked(), `${width}: OpenAI exclusion survives reload`);
    const bounds = await p.getByRole("dialog").boundingBox();
    want(bounds.x >= 0 && bounds.x + bounds.width <= width, `${width}: fallback dialog fits`);
    await save(p);
    await menu(p);
    await p.getByRole("menuitemcheckbox").click();
    await p.keyboard.press("Escape");
    await send(p, "limit please");
    await p.getByText("Plan limit reached. Switched to Azure.", { exact: false }).first().waitFor();
    await p.getByText(/Fake reply .* on Azure/).first().waitFor();
    want((await chip(p).textContent()).includes("Azure"), `${width}: allowed Azure fallback used`);
    await menu(p);
    want(await p.getByRole("menuitem", { name: "Fallback keys…" }).count() === 0 && await p.getByRole("menuitemcheckbox").count() === 0, `${width}: a key session has no switch and no Fallback keys`);
    await p.keyboard.press("Escape");
    // Model changes use the same Azure session and preserve its existing messages.
    const sameThread = p.url();
    await chooseModel(p, "deployment-one");
    await send(p, "first model");
    await p.getByText("first model", { exact: true }).first().waitFor();
    await chooseModel(p, "deployment-two");
    await send(p, "second model");
    await p.getByText("second model", { exact: true }).first().waitFor();
    want(p.url() === sameThread, `${width}: model changes keep the same session`);
    await p.reload();
    await p.getByRole("button", { name: "Model: deployment-two", exact: true }).waitFor();
    await p.getByText("first model", { exact: true }).first().waitFor();
    want(true, `${width}: model and conversation survive reload`);
    // Picked while a turn runs: held as Next, applied at the next send.
    await send(p, "slow turn");
    await p.getByRole("button", { name: "Stop", exact: true }).first().waitFor();
    await pickModel(p, "deployment-one");
    await p.locator(".t-next-deployment", { hasText: "Next: deployment-one" }).waitFor();
    want(await p.getByRole("button", { name: "Model: deployment-two", exact: true }).count() === 1, `${width}: mid-turn the Model chip keeps the running deployment`);
    await p.screenshot({ path: `${SHOTS}/pending-deployment-${width}.png` });
    await p.reload();
    await p.locator(".t-next-deployment", { hasText: "Next: deployment-one" }).waitFor();
    want(true, `${width}: the held deployment survives a reload`);
    await p.getByText(/Fake reply .* on Azure \(deployment-two\)/).last().waitFor({ timeout: 15000 });
    await p.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden" });
    want(true, `${width}: the running turn finished on its own deployment`);
    await send(p, "after slow");
    await p.getByText(/Fake reply .* on Azure \(deployment-one\)/).last().waitFor();
    await p.getByRole("button", { name: "Model: deployment-one", exact: true }).waitFor();
    want(await p.locator(".t-next-deployment").count() === 0, `${width}: applied at the next send, the Next chip gone`);
    // Picked mid-turn, then the current one again: cancelled.
    await send(p, "slow again");
    await p.getByRole("button", { name: "Stop", exact: true }).first().waitFor();
    await pickModel(p, "deployment-two");
    await p.locator(".t-next-deployment").waitFor();
    await pickModel(p, "deployment-one");
    await p.locator(".t-next-deployment").waitFor({ state: "hidden" });
    want(true, `${width}: picking the current deployment cancels the held one`);
    await p.getByText(/Fake reply .* on Azure \(deployment-one\)/).nth(1).waitFor({ timeout: 15000 });
    await p.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden" });
    // Typed on Azure: a configured deployment applies; anything else is refused in the chat, nothing sent.
    await typeModel(p, "  deployment-two  ");
    await p.getByRole("button", { name: "Model: deployment-two", exact: true }).waitFor();
    want(true, `${width}: a typed configured deployment, trimmed, applies`);
    await typeModel(p, "gpt-not-a-deployment");
    await lastNotice(p).filter({ hasText: "isn't a deployment in Settings, Azure" }).waitFor();
    want(await p.getByRole("button", { name: "Model: deployment-two", exact: true }).count() === 1, `${width}: an unknown deployment is refused in the chat, the model kept`);
    for (const bad of ["two words", "semi;colon", "x".repeat(129)]) {
      const { enabled, dialog } = await typeModel(p, bad, { apply: false });
      want(!enabled && await dialog.locator(".t-form-error").count() === 1, `${width}: "${bad.slice(0, 12)}" disables Apply with the reason`);
      if (bad === "two words") await p.screenshot({ path: `${SHOTS}/free-text-invalid-${width}.png` });
      const b = await dialog.boundingBox();
      want(b.x >= 0 && b.x + b.width <= width, `${width}: the dialog fits`);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await dialog.waitFor({ state: "hidden" });
    }
    // Switch back to the plan with every fallback excluded, then hit its limit again.
    await menu(p);
    await p.getByRole("menuitemradio", { name: "ChatGPT plan", exact: true }).click();
    await p.keyboard.press("Escape");
    // Pending (idle): the header already shows the plan; the Model can't change until the carry.
    await p.locator(".t-chip-off", { hasText: "deployment-two" }).waitFor();
    want(await modelChip(p).count() === 0, `${width}: a pending source change disables the Model chip`);
    await fallback(p);
    want(!await p.getByRole("checkbox", { name: "OpenAI API key", exact: true }).isChecked(), `${width}: exclusion survives source carry`);
    await p.getByRole("checkbox", { name: "1. Azure", exact: true }).uncheck();
    await save(p);
    await send(p, "hello on plan");
    await p.getByText(/Fake reply .* on ChatGPT plan/).first().waitFor();
    want((await chip(p).textContent()).includes("5h 100%"), `${width}: ChatGPT chip shows the 5-hour window`);
    await send(p, "limit again");
    await p.getByText("Plan limit reached. No allowed fallback key is available, so nothing switched.", { exact: false }).first().waitFor();
    want((await chip(p).textContent()).includes("ChatGPT plan"), `${width}: all exclusions prevent automatic switching`);
    await menu(p);
    want(await p.getByRole("menuitemcheckbox", { name: "No allowed key" }).count() === 1, `${width}: the switch says there's no allowed key`);
    want(await p.getByRole("menuitemcheckbox").getAttribute("aria-checked") === "true", `${width}: saving the order didn't turn the switch off`);
    await p.keyboard.press("Escape");
    // Typed on the plan: a model id applies to the model only; the plan's labels stay.
    const planChip = await chip(p).textContent();
    await typeModel(p, "gpt-custom-1");
    await modelChip(p).filter({ hasText: /custom/i }).waitFor();
    await send(p, "on a typed model");
    await p.getByText(/Fake reply .* on ChatGPT plan\./).last().waitFor();
    want((await chip(p).textContent()) === planChip, `${width}: a typed model leaves the source and plan % as they were`);
    const before = await modelChip(p).getAttribute("aria-label");
    await typeModel(p, "refuse-this-model");
    await lastNotice(p).filter({ hasText: "is not supported" }).waitFor();
    await p.waitForTimeout(300);
    want((await modelChip(p).getAttribute("aria-label")) === before, `${width}: a model the harness refuses shows in the chat, the model kept`);
    await p.screenshot({ path: `${SHOTS}/refused-model-${width}.png` });
    await p.screenshot({ path: `${SHOTS}/model-fallback-${width}.png` });
    await context.close();
  }
  want(errors.length === 0, `no browser errors: ${errors.join("; ")}`);
} catch (e) {
  await current?.screenshot({ path: `${SHOTS}/failed.png` }).catch(() => {});
  throw e;
} finally { await browser.close(); }
