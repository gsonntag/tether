// Credentials and billing UI against an ISOLATED dev runner + relay + Vite.
//   flock -o /tmp/claude-1001/e2e.lock env BASE=http://127.0.0.1:5261 \
//     CREDENTIAL_FILE=/tmp/claude-1001/keys/dev/credentials.json node scripts/e2e-keys.mjs
// Source badges below use synthetic confirmed reports in the dev browser store: UI checks only.
// Adapter/core tests and real-key acceptance checks verify actual billing. No inference here.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
const { chromium } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const BASE = process.env.BASE ?? "http://127.0.0.1:5261";
const ROOT = "/tmp/claude-1001/keys";
assertLocal();
function assertLocal() { if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(BASE).hostname)) throw new Error("Use an isolated loopback dev stack"); }
const FILE = resolve(process.env.CREDENTIAL_FILE ?? "");
if (!FILE.startsWith(`${ROOT}/`) || !FILE.endsWith("/credentials.json")) throw new Error("CREDENTIAL_FILE must identify the isolated keys test runner's credentials.json");
const SHOTS = process.env.SHOTS ?? `${ROOT}/shots`;
mkdirSync(SHOTS, { recursive: true });
const secrets = [];
const newKey = () => { const key = `test-${randomBytes(24).toString("hex")}`; secrets.push(key); return key; };
const assert = (v, message) => { if (!v) throw new Error(message); };
const browser = await chromium.launch();
const errors = [];
const logs = [];
const incoming = [];
const outgoing = [];
const makePage = async (phone = false) => {
  const ctx = await browser.newContext({ viewport: phone ? { width: 375, height: 812 } : { width: 1280, height: 900 }, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => logs.push(m.text()));
  p.on("websocket", (w) => { w.on("framereceived", (f) => incoming.push(String(f.payload))); w.on("framesent", (f) => outgoing.push(String(f.payload))); });
  await p.goto(`${BASE}/#/credentials`);
  await p.getByRole("form", { name: "Anthropic API key", exact: true }).waitFor();
  const online = await p.evaluate(() => globalThis.__tetherStore.getState().runners.filter((r) => r.online).map((r) => r.id));
  if (online.length !== 1 && !process.env.RUNNER_ID) throw new Error("Multiple runners: identify the isolated test runner with RUNNER_ID");
  if (process.env.RUNNER_ID && online.length > 1) await p.getByLabel("Runner", { exact: true }).selectOption(process.env.RUNNER_ID);
  if (process.env.RUNNER_ID) assert(online.includes(process.env.RUNNER_ID), "RUNNER_ID is not online");
  return p;
};
const slot = (p, label) => p.getByRole("form", { name: label, exact: true });
const isSet = async (p, label, yes) => { await p.waitForFunction(({ label, yes }) => { const f = [...document.forms].find((f) => f.getAttribute("aria-label") === label); return !!f && /^Set(?: ·|$)/.test(f.querySelector(".t-credential-status")?.textContent ?? "") === yes; }, { label, yes }); };
const screenshot = async (p, name) => { for (const input of await p.locator('input[type="password"]').all()) assert(await input.inputValue() === "", "key input wasn't cleared before screenshot"); await p.screenshot({ path: `${SHOTS}/${name}.png` }); };
const save = async (p, label, key) => {
  const form = slot(p, label);
  await form.locator('input[type="password"]').fill(key);
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await isSet(p, label, true);
  assert(await form.locator('input[type="password"]').inputValue() === "", "key retained in input after save");
  assert((statSync(FILE).mode & 0o777) === 0o600, "credentials file is not mode 600");
  assert(readFileSync(FILE, "utf8").includes(key), "saved key absent from private file");
  assert(!(await p.locator("body").innerText()).includes(key), "key echoed in page");
};
const unset = async (p, label) => { await slot(p, label).getByRole("button", { name: "Unset", exact: true }).click(); await isSet(p, label, false); };
const noOverflow = async (p) => assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "page overflows sideways");
let runner;
let session;
async function inject(p, billing, theme) {
  await p.evaluate(({ runner, session, billing, theme }) => {
    for (const el of document.querySelectorAll("[data-theme]")) { el.setAttribute("data-theme", theme); el.style.colorScheme = theme; }
    document.documentElement.style.colorScheme = theme;
    const store = globalThis.__tetherStore;
    const current = store.getState();
    const key = `${runner}\u0000${session}`;
    const summary = { id: session, nativeId: session.split(":")[1], harness: "claude", projectPath: "/tmp/claude-1001/keys/ui", title: "Billing indicator", mode: "live", status: "running", updatedAt: Date.now(), billing };
    store.setState({ summaries: { ...current.summaries, [runner]: { ...(current.summaries[runner] ?? { seq: -1 }), sessions: { ...(current.summaries[runner]?.sessions ?? {}), [session]: summary } } }, views: { ...current.views, [key]: { session: summary, window: { messages: [{ id: "ui", role: "notice", ts: Date.now(), parts: [{ type: "text", text: "Billing display check" }] }], hasOlder: false }, state: { mode: "live", status: "idle", model: "haiku", effort: "low", permissionMode: "default", requests: [], queue: [], billing, plan: { week: { percent: 63 } } }, capabilities: { canSteer: true, terminal: "handoff", subagents: { view: false, stop: false, steer: false } } } } });
  }, { runner, session, billing, theme });
  await p.locator(".t-input").waitFor();
}
function contrast(a, b) {
  const lum = (s) => { const c = s.match(/[\d.]+/g).slice(0, 3).map(Number).map((x) => { x /= 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722; };
  const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
try {
  const desktop = await makePage();
  const phone = await makePage(true);
  runner = process.env.RUNNER_ID ?? await desktop.evaluate(() => globalThis.__tetherStore.getState().runners.find((r) => r.online)?.id);
  assert(runner, "no online test runner");
  for (const label of ["Anthropic API key", "OpenAI API key", "Azure"]) await isSet(desktop, label, false);
  // Only an isolated, initially empty runner is allowed: never overwrite a person's credentials.
  await save(desktop, "Anthropic API key", newKey());
  await screenshot(desktop, "credentials-desktop-set");
  await save(desktop, "Anthropic API key", newKey());
  await unset(desktop, "Anthropic API key");
  await save(desktop, "OpenAI API key", newKey());
  await slot(desktop, "Azure").getByLabel("Endpoint", { exact: true }).fill("https://example.invalid/openai/v1");
  await slot(desktop, "Azure").getByLabel("Deployment", { exact: true }).fill("gpt-6-luna");
  await save(desktop, "Azure", newKey());
  await isSet(desktop, "OpenAI API key", false);
  await unset(desktop, "Azure");
  await isSet(desktop, "OpenAI API key", false);
  await desktop.reload();
  await desktop.getByRole("form", { name: "Anthropic API key", exact: true }).waitFor();
  for (const label of ["Anthropic API key", "OpenAI API key", "Azure"]) await isSet(desktop, label, false);
  await phone.reload();
  await phone.getByRole("form", { name: "Anthropic API key", exact: true }).waitFor();
  await noOverflow(phone);
  await screenshot(phone, "credentials-phone-unset");
  console.log("ok credentials save, replace, exclusive Codex slots, unset, reload; inputs clear and file is private");
  session = `claude:ui-keys-${randomBytes(8).toString("hex")}`;
  for (const [name, p] of [["desktop", desktop], ["phone", phone]]) {
    await p.goto(`${BASE}/#/s/${encodeURIComponent(runner)}/${encodeURIComponent(session)}`);
    // Let the harmless subscribe of the synthetic id fail before injecting UI-only state.
    await p.waitForFunction(({ runner, session }) => globalThis.__tetherStore?.getState().views[`${runner}\u0000${session}`]?.error, { runner, session });
    for (const theme of ["dark", "light"]) {
      for (const [source, billing] of [["anthropic", { kind: "apiKey", label: "Anthropic API key" }], ["openai", { kind: "apiKey", label: "OpenAI API key" }], ["azure", { kind: "provider", label: "Azure" }]]) {
        await inject(p, billing, theme);
        const badge = p.locator(".t-paid-badge");
        assert(await badge.innerText() === billing.label, "wrong billing badge");
        assert(await p.locator(".t-chips > :first-child").innerText() === billing.label, "API badge isn't first");
        const bounds = await badge.boundingBox();
        assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= (await p.viewportSize()).width, "API badge is off screen");
        assert(!(await p.locator(".t-header").innerText()).includes("63%"), "plan usage leaked onto API session");
        const colours = await p.evaluate(() => { const a = getComputedStyle(document.querySelector(".t-paid-badge")), c = getComputedStyle(document.querySelector(".t-api-composer")); return { fg: a.color, bg: a.backgroundColor, border: c.borderTopColor }; });
        assert(colours.bg === colours.border, "composer doesn't use the billing colour");
        assert(contrast(colours.fg, colours.bg) >= 4.5, "billing badge contrast is below 4.5:1");
        assert(await p.locator(".t-api-composer").getAttribute("data-billing") === billing.label, "composer has wrong source");
        await noOverflow(p);
        await screenshot(p, `${name}-${theme}-${source}`);
        await p.evaluate(() => { const c = document.querySelector(".t-chip-options"); c.scrollLeft = c.scrollWidth; });
        const after = await badge.boundingBox();
        assert(after.x === bounds.x, "billing badge moved with scrolling chips");
      }
      await inject(p, { kind: "unknown", label: "Unknown" }, theme);
      assert(await p.locator(".t-paid-badge, .t-api-composer").count() === 0, "unknown shown as API");
      assert((await p.locator(".t-header").innerText()).includes("Unknown"), "unknown billing is hidden");
      await screenshot(p, `${name}-${theme}-unknown`);
      await inject(p, { kind: "plan", label: "Claude plan" }, theme);
      assert(await p.locator(".t-paid-badge, .t-api-composer").count() === 0, "subscription has API colour");
      assert((await p.locator(".t-chips > :first-child").innerText()).includes("Week 63%"), "plan usage isn't first before Mode");
      await screenshot(p, `${name}-${theme}-subscription`);
    }
    // Inline edit is local until saved: Escape sends no rename RPC and restores the title.
    await p.getByRole("button", { name: "Rename session: Billing indicator", exact: true }).click();
    await p.getByRole("textbox", { name: "Session title", exact: true }).fill("Cancelled rename");
    await p.getByRole("textbox", { name: "Session title", exact: true }).press("Escape");
    assert(await p.getByRole("button", { name: "Rename session: Billing indicator", exact: true }).count() === 1, "Escape didn't cancel title edit");
    await inject(p, { kind: "apiKey", label: "Anthropic API key" }, "dark");
    await p.evaluate(() => { location.hash = "#/"; });
    await p.locator(`.t-inbox-row[data-session="${session}"] .t-api-marker`).waitFor();
    if (name === "desktop") assert(await p.locator(".t-rows .t-api-marker").count() > 0, "sidebar API marker missing");
    await screenshot(p, `${name}-home-api`);
    console.log(`ok ${name}: all source badges, neutral unknown, quiet subscription, phone pinning, composer colour, Home/sidebar markers, title cancel`);
  }
  for (const key of secrets) {
    assert(!incoming.some((v) => v.includes(key)), "runner sent a key back to the browser");
    assert(!logs.some((v) => v.includes(key)), "browser console contains a key");
    assert(outgoing.filter((v) => v.includes(key)).length === 1, "browser didn't send the key exactly once");
    if (process.env.RUNNER_PID) assert(!readFileSync(`/proc/${process.env.RUNNER_PID}/cmdline`, "utf8").includes(key), "key found in runner argv");
  }
  const scan = (dir) => { for (const f of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, f.name); if (f.isDirectory()) scan(path); else if (f.isFile() && resolve(path) !== FILE) { const bytes = readFileSync(path); for (const key of secrets) assert(!bytes.includes(Buffer.from(key)), `key found outside private credentials file: ${path}`); } } };
  scan(ROOT);
  assert(errors.length === 0, `browser errors: ${errors.join("; ")}`);
  console.log("all passed; synthetic billing confirms rendering only, no inference or real-key billing tested");
} finally { await browser.close(); }
