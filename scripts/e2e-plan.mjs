// Plan review end to end against a local dev stack and REAL harnesses, desktop and phone:
//   PLAYWRIGHT=/path/to/playwright/index.mjs node scripts/e2e-plan.mjs [claude] [codex]
// Needs a server, a dev runner and vite (README "Local development"). Environment:
//   BASE     the web app (default http://127.0.0.1:5180)
//   RUNNER   the dev runner's id (default tether-dev)
//   SCRATCH  a scratch project folder with a math.js (default ~/.local/share/tether-dev/projects/scratch)
//   SHOTS    where screenshots go
// Each harness: a session in an ordinary mode is put in Plan mode from the Mode menu; its plan opens
// as a document; comments go on a selection and on a clicked paragraph (desktop) and on a tapped
// paragraph (phone); Send feedback gets a revised plan; Approve with notes goes back to the mode
// before Plan, and the work is done.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const BASE = process.env.BASE ?? "http://127.0.0.1:5180";
const RUNNER = process.env.RUNNER ?? "tether-dev";
const SHOTS = process.env.SHOTS ?? "/tmp/tether-e2e-plan";
const SCRATCH = process.env.SCRATCH ?? `${process.env.HOME}/.local/share/tether-dev/projects/scratch`;
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const desktop = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
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
const MOD = (name) => `(performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/${name}")) ?? "/src/${name}")`;
const composer = (p) => p.locator("textarea.t-input[aria-label=Message]");
const idle = (p, ms = 240_000) => p.locator('button[aria-label="Send"]').waitFor({ timeout: ms });
const dialog = (p) => p.locator(".t-plan");
const button = (scope, name) => scope.getByRole("button", { name, exact: true });
async function send(p, text) {
  await composer(p).fill(text);
  await composer(p).press("Enter");
}

/** A new session made through the page's connection, opened. */
async function newSession(p, args) {
  const id = await p.evaluate(
    async ([conn, runnerId, args]) => {
      const { rpc } = await import(eval(conn));
      return (await rpc(runnerId, "newSession", args)).sessionId;
    },
    [MOD("connection.ts"), RUNNER, args],
  );
  const url = `${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`;
  await p.goto(url);
  await composer(p).waitFor({ timeout: 60_000 });
  return { id, url };
}

async function pickMode(p, label) {
  await p.getByRole("button", { name: /^Mode:/ }).click();
  await p.getByRole("menuitemradio", { name: new RegExp(`^${label}`) }).click({ timeout: 90_000 });
  await p.getByRole("button", { name: `Mode: ${label}` }).waitFor({ timeout: 30_000 });
}

/** The open requests in the page's model of the session it shows. */
const requests = (p) =>
  p.evaluate(async (store) => {
    const { useStore } = await import(eval(store));
    const id = decodeURIComponent(location.hash.split("/").pop());
    const v = Object.entries(useStore.getState().views).find(([k]) => k.endsWith(`\u0000${id}`))?.[1];
    return v?.state?.requests ?? [];
  }, MOD("store.ts"));

/** Selects the text `needle` inside the plan document and lets go of the mouse there. */
async function selectInDoc(p, needle) {
  const found = await p.evaluate((needle) => {
    const doc = document.querySelector(".t-plan-doc");
    const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.nodeValue.indexOf(needle);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + needle.length);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      n.parentElement.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return true;
    }
    return false;
  }, needle);
  if (!found) fail(`"${needle}" isn't in the plan`);
}

/** Some of the plan's text to select: a few words of plain text in the second list item. */
const someText = (p, selector) =>
  p.evaluate((selector) => {
    const els = document.querySelectorAll(`.t-plan-doc ${selector}`);
    const el = els[1] ?? els[0];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const words = n.nodeValue.trim().split(/\s+/);
      if (words.length >= 2) return words.slice(0, 3).join(" ");
    }
    return "";
  }, selector);

async function commentDesktop(p, text) {
  await button(p.locator(".t-plan-slot"), "Comment").click();
  await p.locator(".t-plan-composer textarea").fill(text);
  await button(p.locator(".t-plan-composer"), "Comment").click();
}

const sessionFile = (nativeId) => {
  const dir = `${process.env.HOME}/.claude/projects/${SCRATCH.replace(/[^A-Za-z0-9]/g, "-")}`;
  return readFileSync(`${dir}/${nativeId}.jsonl`, "utf8");
};

async function review(h, { startMode, task, expect }) {
  writeFileSync(`${SCRATCH}/math.js`, "export function add(a, b) {\n  return a + b;\n}\n");
  const a = await page(desktop);
  const args = h === "claude" ? { harness: "claude", projectPath: SCRATCH, model: "haiku", permissionMode: startMode } : { harness: "codex", projectPath: SCRATCH, effort: "low", permissionMode: startMode };
  const { id, url } = await newSession(a, args);
  ok(`${h}: new session ${id}`);
  await pickMode(a, "Plan");
  ok(`${h}: Plan picked from the Mode menu`);
  await send(a, `Make a plan for this: ${task} Write the plan in markdown: a short heading, a one-sentence summary, then three numbered steps. Don't change any file yet.${h === "claude" ? " Present it with ExitPlanMode." : ""}`);

  // The plan opens by itself as a document.
  await dialog(a).waitFor({ timeout: 300_000 });
  await a.waitForTimeout(500);
  await shot(a, `${h}-plan-desktop`);
  const items = await a.locator(".t-plan-doc li").count();
  if (!items) fail(`${h}: the plan isn't rendered markdown (no list items)`);
  ok(`${h}: the plan opened as a rendered document (${items} list items)`);

  // A comment on a selection, one on a clicked paragraph, and a general one.
  const picked = await someText(a, "li");
  await selectInDoc(a, picked);
  await commentDesktop(a, "Use an arrow function here.");
  await a.locator(".t-plan-doc h1, .t-plan-doc h2, .t-plan-doc h3, .t-plan-doc [role=paragraph]").first().click();
  await commentDesktop(a, "Name it more clearly.");
  // One more, then removed: it never goes out.
  await a.locator(".t-plan-doc li").last().click();
  await commentDesktop(a, "DROP ME");
  await button(a.locator(".t-plan-card", { hasText: "DROP ME" }), "Delete").click();
  // Edited before sending.
  await button(a.locator(".t-plan-card", { hasText: "Name it more clearly." }), "Edit").click();
  await a.locator(".t-plan-card textarea[aria-label='Edit comment']").fill(`Call it ${expect.name}.`);
  await a.locator(".t-plan-general").click();
  await a.locator(".t-plan-general").fill("Keep it small.");
  const cards = await a.locator(".t-plan-margin .t-plan-card").count();
  if (cards !== 2) fail(`${h}: ${cards} comment cards`);
  await shot(a, `${h}-comments-desktop`);
  ok(`${h}: comments on a selection and on a paragraph sit in the margin; edited and deleted before sending`);

  // The phone sees the same plan, fullscreen.
  const b = await page(phone, url);
  await dialog(b).waitFor({ timeout: 30_000 });
  await b.waitForTimeout(800); // the dialog fades in
  await shot(b, `${h}-plan-phone`);
  ok(`${h}: the phone opens the same plan full screen`);

  const [before] = await requests(a);
  await button(a.locator(".t-plan-actions"), "Send feedback").click();
  await dialog(a).waitFor({ state: "detached", timeout: 15_000 });
  ok(`${h}: Send feedback sent the plan back`);
  // The revised plan opens by itself (a new request) on both devices.
  // A question the agent asks on the way (Codex's plan mode does) gets its first option.
  for (const t0 = Date.now(); ; await a.waitForTimeout(1000)) {
    if (Date.now() - t0 > 300_000) fail(`${h}: no revised plan`);
    const open = await requests(a);
    if (open.some((r) => r.plan !== undefined && r.id !== before.id)) break;
    const q = open.find((r) => r.kind === "question");
    if (q) {
      const answers = (q.questions ?? [{ options: (q.options ?? []).map((label) => ({ label })) }]).map((x) => x.options[0]?.label ?? "Your call.");
      await a.evaluate(([conn, runnerId, sessionId, requestId, answers]) => import(eval(conn)).then(({ rpc }) => rpc(runnerId, "answerRequest", { sessionId, requestId, allow: true, answers })), [MOD("connection.ts"), RUNNER, id, q.id, answers]);
      ok(`${h}: answered a question on the way: ${answers.join(", ")}`);
    }
  }
  await dialog(b).waitFor({ timeout: 30_000 });
  const modeNow = await a.locator(".t-header").innerText();
  if (!/Mode\s*Plan/.test(modeNow)) fail(`${h}: not in Plan mode after revising: ${modeNow}`);
  ok(`${h}: a revised plan came back, still in Plan mode`);

  // Phone: tap a paragraph, Comment opens the sheet, then Approve with notes.
  await b.locator(".t-plan-doc li").first().tap();
  await button(b.locator(".t-plan-actions"), "Comment").tap();
  await b.locator(".t-plan-sheet .t-plan-composer textarea").fill("Add a test too.");
  await shot(b, `${h}-sheet-phone`);
  await button(b.locator(".t-plan-sheet .t-plan-composer"), "Comment").tap();
  await shot(b, `${h}-comment-phone`);
  ok(`${h}: on the phone a tapped paragraph gets a comment in the bottom sheet`);
  await a.locator(".t-plan").waitFor();
  await button(b.locator(".t-plan-actions"), "Approve with notes").tap();
  await dialog(b).waitFor({ state: "detached", timeout: 15_000 });
  await a.getByRole("button", { name: `Mode: ${expect.mode}` }).waitFor({ timeout: 60_000 });
  ok(`${h}: approved with notes from the phone; the mode went back to ${expect.mode}`);
  // The work goes ahead (it may then ask to run a check, which isn't this test's business: stopped).
  const t0 = Date.now();
  while (!expect.code.test(readFileSync(`${SCRATCH}/math.js`, "utf8"))) {
    if (Date.now() - t0 > 300_000) fail(`${h}: math.js wasn't changed as planned:\n${readFileSync(`${SCRATCH}/math.js`, "utf8")}`);
    await a.waitForTimeout(1000);
  }
  await a.waitForTimeout(3000);
  await shot(a, `${h}-done-desktop`);
  await a.evaluate(
    async ([conn, runnerId, sessionId]) => {
      const { rpc } = await import(eval(conn));
      await rpc(runnerId, "interrupt", { sessionId }).catch(() => {});
    },
    [MOD("connection.ts"), RUNNER, id],
  );
  await idle(a, 60_000);
  ok(`${h}: the work went ahead after approval`);
  await a.close();
  await b.close();
  return id;
}

const steps = {
  async claude() {
    const id = await review("claude", { startMode: "acceptEdits", task: "add a subtract(a, b) function to math.js.", expect: { mode: "Accept edits", name: "subtractNumbers", code: /subtract/i } });
    const native = id.split(":").pop();
    const store = sessionFile(native);
    if (!/Please revise the plan to address my comments/.test(store) || !/> /.test(store)) fail("claude: the feedback isn't in the session's store");
    if (!/Notes on the plan:/.test(store)) fail("claude: the notes aren't in the session's store");
    ok("claude: the feedback (quotes, then comments) and the approval's notes reached Claude");
  },
  async codex() {
    await review("codex", { startMode: "auto", task: "add a multiply(a, b) function to math.js.", expect: { mode: "Auto", name: "multiplyNumbers", code: /multiply/i } });
  },
};

const pick = process.argv.slice(2);
try {
  for (const name of pick.length ? pick : ["claude", "codex"]) await steps[name]();
  if (errors.length) fail(`page errors: ${errors.join("; ")}`);
  console.log(`all done; screenshots in ${SHOTS}`);
} finally {
  await browser.close();
}
