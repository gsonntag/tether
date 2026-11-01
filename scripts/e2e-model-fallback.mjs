// Run against scripts/limit-runner.ts through the dev relay (no real model requests).
// BASE=http://127.0.0.1:15180 RUNNER=tether-model-fallback-check PROJECT=/tmp/tether-model-fallback-check/project node scripts/e2e-model-fallback.mjs
const { chromium } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const BASE = process.env.BASE ?? "http://127.0.0.1:15180";
const RUNNER = process.env.RUNNER ?? "tether-model-fallback-check";
const PROJECT = process.env.PROJECT ?? "/tmp/tether-model-fallback-check/project";
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
const chooseModel = async (p, name) => {
  await p.getByRole("button", { name: /^Model:/ }).click();
  await p.getByRole("menuitemradio", { name, exact: true }).click();
  await p.getByRole("button", { name: `Model: ${name}`, exact: true }).waitFor();
};
try {
  for (const width of [1280, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 812 }, hasTouch: width === 375, isMobile: width === 375 });
    const p = await context.newPage();
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
    await fallback(p);
    want(!await p.getByRole("checkbox", { name: "OpenAI API key", exact: true }).isChecked(), `${width}: exclusion survives source carry`);
    await p.getByRole("checkbox", { name: "1. Azure", exact: true }).uncheck();
    await save(p);
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
    // Switch back to the plan with every fallback excluded, then hit its limit again.
    await menu(p);
    await p.getByRole("menuitemradio", { name: "ChatGPT plan", exact: true }).click();
    await p.keyboard.press("Escape");
    await send(p, "hello on plan");
    await p.getByText(/Fake reply .* on ChatGPT plan/).first().waitFor();
    want((await chip(p).textContent()).includes("5h 100%"), `${width}: ChatGPT chip shows the 5-hour window`);
    await send(p, "limit again");
    await p.getByText("Plan limit reached. No allowed fallback key is available, so nothing switched.", { exact: false }).first().waitFor();
    want((await chip(p).textContent()).includes("ChatGPT plan"), `${width}: all exclusions prevent automatic switching`);
    await p.screenshot({ path: `/tmp/tether-model-fallback-${width}.png` });
    await context.close();
  }
  want(errors.length === 0, `no browser errors: ${errors.join("; ")}`);
} finally { await browser.close(); }
