// P2 end-to-end (requests) against a local dev stack and REAL Claude (Haiku), desktop and phone:
//   PLAYWRIGHT=/path/to/playwright/index.mjs node scripts/e2e-p2.mjs [step…]
// Needs a server, a dev runner and vite (README "Local development"). Environment:
//   BASE            the web app (default http://127.0.0.1:5180)
//   RUNNER          the dev runner's id (default tether-dev)
//   SCRATCH         a scratch project folder (default ~/.local/share/tether-dev/projects/scratch)
//   RESTART_RUNNER  a command that restarts the dev runner (for `restart`)
//   SHOTS           where screenshots go
// Steps: new approve deny question multi subagent restart plan planApprove. Each real turn is small (Haiku).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const BASE = process.env.BASE ?? "http://127.0.0.1:5180";
const RUNNER = process.env.RUNNER ?? "tether-dev";
const SHOTS = process.env.SHOTS ?? "/tmp/tether-e2e-p2";
const SCRATCH = process.env.SCRATCH ?? `${process.env.HOME}/.local/share/tether-dev/projects/scratch`;
const RESTART = process.env.RESTART_RUNNER;
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
const noOverflow = async (p, where) => {
  const w = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (w > 1) fail(`${where}: page scrolls sideways by ${w}px`);
};
const composer = (p) => p.locator("textarea.t-input[aria-label=Message]");
const idle = (p, ms = 120_000) => p.locator('button[aria-label="Send"]').waitFor({ timeout: ms });
async function send(p, text) {
  await composer(p).fill(text);
  await composer(p).press("Enter");
}
const card = (p) => p.locator(".t-req").first();
const button = (scope, name) => scope.getByRole("button", { name, exact: true });
// The page's own modules: Vite may serve them with a ?t= stamp after an edit, so they're imported
// by the URL the page loaded (a bare path would make a second, empty copy).
const MOD = (name) => `(performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/${name}")) ?? "/src/${name}")`;

/** The open requests in the page's model of the session it shows. */
const openRequests = (p) =>
  p.evaluate(async (store) => {
    const { useStore } = await import(eval(store));
    const id = decodeURIComponent(location.hash.split("/").pop());
    const v = Object.entries(useStore.getState().views).find(([k]) => k.endsWith(`\u0000${id}`))?.[1];
    return v?.state?.requests ?? [];
  }, MOD("store.ts"));
/** An answer straight through the page's connection (a second device answering late). */
const answerVia = (p, sessionId, requestId) =>
  p.evaluate(
    async ([runnerId, sessionId, requestId, conn]) => {
      const { rpc } = await import(eval(conn));
      try {
        await rpc(runnerId, "answerRequest", { sessionId, requestId, allow: true });
        return "ok";
      } catch (e) {
        return e.message;
      }
    },
    [RUNNER, sessionId, requestId, MOD("connection.ts")],
  );
const scratch = (f) => `${SCRATCH}/${f}`;
const waitFile = async (f, ms = 90_000) => {
  const t = Date.now();
  while (!existsSync(scratch(f))) {
    if (Date.now() - t > ms) fail(`${f} never appeared`);
    await new Promise((r) => setTimeout(r, 500));
  }
  return readFileSync(scratch(f), "utf8");
};

let session; // the session URL made in `new`
const sessionId = () => decodeURIComponent(session.split("/").pop());

const steps = {
  async new() {
    for (const f of ["notes.txt", "sub.txt", "restart.txt", "denied.txt", "denied2.txt"]) rmSync(scratch(f), { force: true });
    const p = await page(desktop);
    await p.getByRole("button", { name: "New session" }).first().click();
    await p.locator("#t-new-path").fill(SCRATCH);
    // Another runner may be connected: pick ours when the dialog asks.
    const runnerSelect = p.locator(".t-form select.t-select", { has: p.locator(`option[value="${RUNNER}"]`) });
    if (await runnerSelect.count()) await runnerSelect.selectOption(RUNNER);
    await p.waitForFunction(() => [...document.querySelectorAll(".t-form select option")].some((o) => o.value === "haiku"), null, { timeout: 30_000 });
    await p.locator(".t-form select.t-select", { has: p.locator('option[value="haiku"]') }).selectOption("haiku");
    await p.locator(".t-form select.t-select", { has: p.locator('option[value="acceptEdits"]') }).selectOption("default");
    await p.getByRole("button", { name: "Create" }).click();
    await p.waitForURL(/#\/s\//, { timeout: 60_000 });
    session = p.url();
    const mode = await p.locator(".t-header").innerText();
    if (!/Ask first/.test(mode)) fail(`header doesn't say Ask first: ${mode}`);
    ok(`new Haiku session in Ask first mode: ${sessionId()}`);
    await p.close();
  },

  async approve() {
    // P2 acceptance: an edit request appears on both devices; answering on the phone clears it on
    // desktop; a second answer says "Already answered".
    const a = await page(desktop, session);
    const b = await page(phone, session);
    await composer(a).waitFor();
    await composer(b).waitFor();
    await send(a, "Create a file notes.txt containing the word hello, using the Write tool. Do nothing else.");
    await card(a).waitFor({ timeout: 90_000 });
    await card(b).waitFor({ timeout: 10_000 });
    const title = await card(a).locator(".t-req-title").innerText();
    if (!/write notes\.txt/i.test(title)) fail(`unexpected request title: ${title}`);
    await a.locator(".t-tool-waiting").first().waitFor({ timeout: 5_000 });
    const [ra] = await openRequests(a);
    const [rb] = await openRequests(b);
    if (!ra || ra.id !== rb?.id) fail("the devices show different requests");
    // The sidebar row says the session needs you (phone: in the drawer, so check desktop).
    await a.locator(".t-row .t-needs").first().waitFor({ timeout: 5_000 });
    await shot(a, "approve-desktop");
    await shot(b, "approve-phone");
    await noOverflow(b, "phone with a request open");
    ok(`an edit request shows on desktop and phone ("${title}"), the card says Waiting for you, the row says Needs you`);

    await button(card(b), "Approve").tap();
    await card(a).waitFor({ state: "detached", timeout: 10_000 });
    await card(b).waitFor({ state: "detached", timeout: 10_000 });
    ok("approved on the phone: the request cleared on desktop");
    const again = await answerVia(a, sessionId(), ra.id);
    if (!/^Already answered/.test(again)) fail(`a second answer said: ${again}`);
    ok(`a second answer from desktop says "${again}"`);
    // The same through the UI: desktop still shows the card (as if the phone's answer hadn't
    // reached it yet) and taps Approve.
    await a.evaluate(
      async ([store, r]) => {
        const { useStore } = await import(eval(store));
        const views = { ...useStore.getState().views };
        const k = Object.keys(views).find((x) => x.endsWith(`\u0000${r.sessionId}`));
        views[k] = { ...views[k], state: { ...views[k].state, requests: [r] } };
        useStore.setState({ views });
      },
      [MOD("store.ts"), ra],
    );
    await button(card(a), "Approve").click();
    await a.locator(".t-dock").getByText("Already answered.").waitFor({ timeout: 5_000 });
    await shot(a, "already-answered");
    ok("tapping Approve on a stale card says Already answered. in the dock");
    await idle(a);
    if (!/hello/i.test(await waitFile("notes.txt"))) fail("notes.txt lacks hello");
    ok("Claude wrote notes.txt");
    await a.close();
    await b.close();
  },

  async deny() {
    const p = await page(desktop, session);
    await composer(p).waitFor();
    // ls and pwd run without asking (read-only); touch asks.
    await send(p, "Run the shell command `touch denied.txt` with the Bash tool, then tell me what happened.");
    await card(p).waitFor({ timeout: 90_000 });
    if (!/run a command/i.test(await card(p).innerText())) fail("expected a command request");
    await button(card(p), "Deny with reason").click();
    await card(p).getByRole("textbox", { name: "Reason" }).fill("Don't run shell commands. Just tell me the command you would have run.");
    await shot(p, "deny-reason");
    await card(p).getByRole("textbox", { name: "Reason" }).press("Enter");
    await card(p).waitFor({ state: "detached", timeout: 10_000 });
    await p.waitForFunction(() => /would have run/i.test([...document.querySelectorAll(".t-msg.assistant")].at(-1)?.innerText ?? ""), null, { timeout: 90_000 });
    await idle(p, 120_000);
    if (existsSync(scratch("denied.txt"))) fail("denied.txt exists after the denial");
    ok("denied with a reason: Claude read it and carried on");
    // A plain Deny stops the turn.
    await send(p, "Run `touch denied2.txt` with the Bash tool.");
    await card(p).waitFor({ timeout: 90_000 });
    await button(card(p), "Deny").click();
    await card(p).waitFor({ state: "detached", timeout: 10_000 });
    await idle(p, 60_000);
    if (existsSync(scratch("denied2.txt"))) fail("denied2.txt exists after the denial");
    ok("a plain Deny closed the request and the turn ended");
    await p.close();
  },

  async question() {
    const a = await page(desktop, session);
    const b = await page(phone, session);
    await composer(a).waitFor();
    await send(a, "Use the AskUserQuestion tool to ask me which color I prefer, with exactly two options: Red and Blue. After I answer, reply with only the color I picked.");
    await card(b).waitFor({ timeout: 90_000 });
    await card(a).waitFor({ timeout: 10_000 });
    const opts = await card(b).locator(".t-option-label").allInnerTexts();
    if (!opts.includes("Red") || !opts.includes("Blue")) fail(`options: ${opts}`);
    if (!(await card(b).getByRole("textbox").count())) fail("no free-text answer box");
    await shot(b, "question-phone");
    await noOverflow(b, "phone with a question");
    await card(b).locator(".t-option", { hasText: "Blue" }).tap();
    await card(a).waitFor({ state: "detached", timeout: 10_000 });
    await idle(a);
    await a.waitForFunction(() => /blue/i.test([...document.querySelectorAll(".t-msg.assistant")].at(-1)?.innerText ?? ""), null, { timeout: 30_000 });
    ok(`a question shows its options (${opts.join(", ")}) and a text box; tapping Blue on the phone answered it`);
    await a.close();
    await b.close();
  },

  async subagent() {
    const p = await page(desktop, session);
    await composer(p).waitFor();
    await send(p, "Use the Agent tool to start a general-purpose subagent that creates sub.txt containing the words from subagent, using the Write tool. Wait for it, then say done.");
    await card(p).waitFor({ timeout: 120_000 });
    const from = card(p).locator(".t-req-from");
    if (!(await from.count())) fail("the parent's card doesn't say it's from a subagent");
    await shot(p, "subagent-request-parent");
    const [r] = await openRequests(p);
    await from.click();
    await p.waitForURL(/%2F/, { timeout: 10_000 });
    await card(p).waitFor({ timeout: 10_000 });
    const [rc] = await openRequests(p);
    if (rc?.id !== r.id) fail("the subagent's view shows a different request");
    await shot(p, "subagent-request-child");
    ok("a subagent's request shows in the parent (marked as the subagent's) and in the subagent's own view");
    await button(card(p), "Approve").click();
    await card(p).waitFor({ state: "detached", timeout: 10_000 });
    await waitFile("sub.txt");
    await p.goto(session);
    await idle(p, 180_000);
    if ((await openRequests(p)).length) fail("the parent still shows the request");
    ok("approved in the subagent's view: it cleared in the parent too, and sub.txt was written");
    await p.close();
  },

  async restart() {
    if (!RESTART) return console.log("skip restart (set RESTART_RUNNER)");
    const a = await page(desktop, session);
    const b = await page(phone, session);
    await composer(a).waitFor();
    await send(a, "Create a file restart.txt containing the words after restart, using the Write tool. Do nothing else.");
    await card(a).waitFor({ timeout: 90_000 });
    const [before] = await openRequests(a);
    // Detached, not waited on: the restarted runner outlives this script.
    spawn("bash", ["-c", RESTART], { detached: true, stdio: "ignore" }).unref();
    await a.getByText(/runner restarted while Claude was waiting/).waitFor({ timeout: 45_000 });
    await card(a).waitFor({ timeout: 10_000 });
    await card(b).waitFor({ timeout: 10_000 });
    const [after] = await openRequests(b);
    if (after?.id !== before.id) fail(`the request came back as ${after?.id}, not ${before.id}`);
    await shot(b, "restart-phone");
    ok("the runner restarted with a request open: both devices show it again, same id");
    await button(card(b), "Approve").tap();
    await card(a).waitFor({ state: "detached", timeout: 10_000 });
    if (!/after restart/.test(await waitFile("restart.txt", 120_000))) fail("restart.txt is wrong");
    await idle(a, 120_000);
    ok("approved after the restart: the session resumed and Claude wrote restart.txt");
    await a.close();
    await b.close();
  },

  async plan() {
    const p = await page(desktop, session);
    await composer(p).waitFor();
    await p.getByRole("button", { name: /^Mode:/ }).click();
    await p.getByRole("menuitemradio", { name: /^Plan/ }).click();
    await p.getByRole("button", { name: "Mode: Plan" }).waitFor({ timeout: 10_000 });
    await send(p, "Plan how to add a subtract function to math.ts, in at most three lines, then present the plan with ExitPlanMode. Don't implement it yet.");
    await card(p).waitFor({ timeout: 120_000 });
    await card(p).locator(".t-req-plan").waitFor({ timeout: 5_000 });
    if (!(await button(card(p), "Approve and accept edits").count())) fail("no Approve and accept edits");
    await shot(p, "plan");
    await button(card(p), "Deny with reason").click();
    await card(p).getByRole("textbox", { name: "Reason" }).fill("Not now. Stop here.");
    await button(card(p), "Deny").click();
    await card(p).waitFor({ state: "detached", timeout: 10_000 });
    await idle(p, 120_000);
    ok("plan mode: the plan shows as markdown with Approve / Approve and accept edits; denying with a reason kept planning");
    await p.getByRole("button", { name: /^Mode:/ }).click();
    await p.getByRole("menuitemradio", { name: /^Ask first/ }).click();
    await p.getByRole("button", { name: "Mode: Ask first" }).waitFor({ timeout: 10_000 });
    await p.close();
  },

  async planApprove() {
    const p = await page(desktop, session);
    await composer(p).waitFor();
    await p.getByRole("button", { name: /^Mode:/ }).click();
    await p.getByRole("menuitemradio", { name: /^Plan/ }).click();
    await p.getByRole("button", { name: "Mode: Plan" }).waitFor({ timeout: 10_000 });
    await send(p, "Plan adding `export const subtract = (a: number, b: number) => a - b;` to math.ts, in one line, then present it with ExitPlanMode. Once approved, make exactly that edit and nothing else.");
    await card(p).locator(".t-req-plan").waitFor({ timeout: 120_000 });
    await button(card(p), "Approve and accept edits").click();
    await p.getByRole("button", { name: "Mode: Accept edits" }).waitFor({ timeout: 30_000 });
    await idle(p, 120_000);
    if (!/subtract/.test(readFileSync(scratch("math.ts"), "utf8"))) fail("math.ts wasn't edited");
    ok("Approve and accept edits: the mode became Accept edits on its own and the edit went ahead without another card");
    await p.getByRole("button", { name: /^Mode:/ }).click();
    await p.getByRole("menuitemradio", { name: /^Ask first/ }).click();
    await p.getByRole("button", { name: "Mode: Ask first" }).waitFor({ timeout: 10_000 });
    await p.close();
  },

  async multi() {
    const p = await page(phone, session);
    await composer(p).waitFor();
    await p.waitForTimeout(1000);
    if (!(await card(p).count())) {
      await composer(p).fill("Use AskUserQuestion once to ask which sizes I want, with options S, M and L, allowing several answers (multiSelect). Then reply with only my answer.");
      await p.getByRole("button", { name: "Send" }).click();
    }
    await card(p).waitFor({ timeout: 90_000 });
    const option = (label) => card(p).locator(".t-option").filter({ has: p.locator(".t-option-label", { hasText: new RegExp(`^${label}$`) }) });
    await option("S").tap();
    await option("L").tap();
    const pressed = await card(p).locator('.t-option[aria-pressed="true"]').count();
    if (pressed !== 2) fail(`${pressed} options pressed`);
    await shot(p, "multi-phone");
    await button(card(p), "Send answer").tap();
    await card(p).waitFor({ state: "detached", timeout: 10_000 });
    await idle(p);
    await p.waitForFunction(() => /S.*L/.test([...document.querySelectorAll(".t-msg.assistant")].at(-1)?.innerText ?? ""), null, { timeout: 30_000 });
    ok("a multi-select question: options toggle and Send answer sends them together");
    await p.close();
  },
};

const pick = process.argv.slice(2);
try {
  for (const name of pick.length ? pick : ["new", "approve", "deny", "question", "multi", "subagent", "restart", "plan", "planApprove"]) {
    if (!session && name !== "new" && process.env.SESSION) session = `${BASE}/#/s/${RUNNER}/${encodeURIComponent(process.env.SESSION)}`;
    console.log(`\n== ${name}`);
    await steps[name]();
  }
  if (errors.length) fail(`page errors:\n${errors.join("\n")}`);
  console.log("\nall passed");
} finally {
  await browser.close();
}
