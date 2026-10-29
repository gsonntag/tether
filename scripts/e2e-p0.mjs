// End-to-end check of P0 against a local dev stack, desktop and phone viewports.
// Needs vite running on :5180 (cd web && bunx vite); starts and stops the server and runner itself.
//   PLAYWRIGHT=/path/to/playwright/index.mjs OUT=/tmp/e2e node scripts/e2e-p0.mjs
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";

const SP = process.env.OUT ?? "/tmp/tether-e2e";
mkdirSync(`${SP}/logs`, { recursive: true });
mkdirSync(`${SP}/shots`, { recursive: true });
// Its own config dirs and runner ids, never ~/.config/tether.
const DEV = `${process.env.HOME}/.local/share/tether-dev`;
const DEV2 = `${process.env.HOME}/.local/share/tether-dev2`;
for (const [dir, id] of [[DEV, "tether-dev"], [DEV2, "tether-dev-2"]]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/runner.json`, JSON.stringify({ runnerId: id }));
}
const APP = "http://127.0.0.1:5180/";
const env = { ...process.env, TETHER_URL: "http://localhost:8790", TETHER_TOKEN: "dev", TETHER_CONFIG_DIR: DEV };
delete env.FOLIATION_ISSUER; delete env.PORT;
const procs = {};
function start(name, cwd) {
  const out = openSync(`${SP}/logs/${name}.log`, "a");
  const p = spawn("bun", ["src/index.ts"], { cwd, env, stdio: ["ignore", out, out] });
  procs[name] = p;
  return p;
}
async function stop(name) {
  const p = procs[name];
  if (!p || p.exitCode !== null) return;
  p.kill("SIGTERM");
  await new Promise((r) => p.once("exit", r));
}
const startServer = () => start("server", new URL("../server", import.meta.url).pathname);
const startRunner = () => start("runner", new URL("../runner", import.meta.url).pathname);

let failures = 0;
async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)`); }
  catch (e) { failures++; console.log(`FAIL ${name}: ${e.message.split("\n")[0]}`); }
}

const browser = await chromium.launch();
const desktop = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const phone = await (await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })).newPage();
const pages = { desktop, phone };
const errors = [];
for (const [n, p] of Object.entries(pages)) p.on("pageerror", (e) => errors.push(`${n}: ${e.message}`));

const row = (p) => p.getByRole("main").getByText("tether-dev", { exact: true });
const statusText = (p, re) => p.getByRole("main").getByText(re).first();
const shot = (p, name) => p.screenshot({ path: `${SP}/shots/${name}.png` });

try {
  startServer();
  await new Promise((r) => setTimeout(r, 800));
  startRunner();
  for (const [n, p] of Object.entries(pages)) {
    await step(`${n}: runner shows connected`, async () => {
      await p.goto(APP);
      await row(p).waitFor({ timeout: 10000 });
      await statusText(p, /^Connected$/).waitFor({ timeout: 10000 });
      await statusText(p, /Claude Code 2\.\d+\.\d+ · Codex 0\.\d+/).waitFor({ timeout: 2000 });
      await shot(p, `${n}-connected`);
    });
  }
  await step("phone: no horizontal scroll at 375 px", async () => {
    const w = await phone.evaluate(() => document.documentElement.scrollWidth);
    if (w > 375) throw new Error(`scrollWidth ${w}`);
  });
  await step("phone: drawer opens and lists the runner", async () => {
    const toggle = phone.getByRole("button", { name: /menu|navigation|open/i }).first();
    await toggle.click();
    await phone.getByRole("dialog").getByText("tether-dev").waitFor({ timeout: 3000 });
    await shot(phone, "phone-drawer");
    await phone.keyboard.press("Escape");
    await phone.getByRole("dialog").waitFor({ state: "hidden", timeout: 3000 });
  });
  await step("desktop: ping answers", async () => {
    await desktop.getByRole("button", { name: "Ping" }).click();
    await statusText(desktop, /Answered in \d+ ms/).waitFor({ timeout: 5000 });
  });
  await step("kill runner -> disconnected on both", async () => {
    procs.runner.kill("SIGKILL");
    for (const p of [desktop, phone]) await statusText(p, /Disconnected · last seen/).waitFor({ timeout: 8000 });
    await shot(desktop, "desktop-disconnected");
    await shot(phone, "phone-disconnected");
  });
  await step("restart runner -> connected on both", async () => {
    startRunner();
    for (const p of [desktop, phone]) await statusText(p, /^Connected$/).waitFor({ timeout: 15000 });
  });
  await step("restart server -> banner, then browsers and runner reconnect", async () => {
    await stop("server");
    for (const p of [desktop, phone]) await p.getByText(/Reconnecting…/).waitFor({ timeout: 8000 });
    await shot(desktop, "desktop-reconnecting");
    await shot(phone, "phone-reconnecting");
    startServer();
    for (const p of [desktop, phone]) {
      await p.getByText(/Reconnecting…/).waitFor({ state: "hidden", timeout: 20000 });
      await statusText(p, /^Connected$/).waitFor({ timeout: 40000 });
    }
  });
  await step("desktop: ping still answers after both reconnected", async () => {
    await desktop.getByRole("button", { name: "Ping" }).click();
    await desktop.getByRole("main").getByText(/Answered in \d+ ms/).first().waitFor({ timeout: 5000 });
  });
  await step("reload keeps the runner list (disconnected runner remembered)", async () => {
    procs.runner.kill("SIGKILL");
    await statusText(desktop, /Disconnected/).waitFor({ timeout: 8000 });
    await desktop.reload();
    await statusText(desktop, /Disconnected · last seen/).waitFor({ timeout: 8000 });
    startRunner();
    await statusText(desktop, /^Connected$/).waitFor({ timeout: 15000 });
  });
  await step("second runner shows beside the first; forget after it leaves", async () => {
    const out = openSync(`${SP}/logs/runner2.log`, "w");
    const r2 = spawn("bun", ["src/index.ts"], { cwd: new URL("../runner", import.meta.url).pathname, env: { ...env, TETHER_CONFIG_DIR: DEV2 }, stdio: ["ignore", out, out] });
    await desktop.getByRole("main").getByText("tether-dev-2", { exact: true }).waitFor({ timeout: 10000 });
    await desktop.getByRole("navigation").getByText("tether-dev-2", { exact: true }).waitFor({ timeout: 2000 });
    await shot(desktop, "desktop-two-runners");
    r2.kill("SIGKILL");
    await desktop.getByRole("button", { name: "Forget tether-dev-2" }).click({ timeout: 8000 });
    await desktop.getByRole("main").getByText("tether-dev-2", { exact: true }).waitFor({ state: "detached", timeout: 3000 });
  });
  await step("runner with a bad token is refused and says so", async () => {
    const r3 = spawn("bun", ["src/index.ts"], { cwd: new URL("../runner", import.meta.url).pathname, env: { ...env, TETHER_TOKEN: "wrong", TETHER_CONFIG_DIR: DEV2 } });
    let log = "";
    r3.stdout.on("data", (d) => (log += d));
    const t0 = Date.now();
    while (!log.includes("refused TETHER_TOKEN (403)") && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 100));
    r3.kill("SIGKILL");
    if (!log.includes("refused TETHER_TOKEN (403)")) throw new Error(log);
    if (await desktop.getByRole("main").getByText("tether-dev-2").count()) throw new Error("refused runner listed");
  });
  if (errors.length) { failures++; console.log("page errors:", errors); }
} finally {
  await browser.close();
  await stop("runner");
  await stop("server");
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
