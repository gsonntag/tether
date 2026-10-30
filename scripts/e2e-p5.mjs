// P5 end-to-end against a local dev stack, REAL Claude (Haiku) and the REAL shared Codex daemon
// (the cheapest model at Low effort), desktop (1280) and phone (375):
//   PLAYWRIGHT=/path/to/playwright/index.mjs node scripts/e2e-p5.mjs [step…]
// Needs a server, a dev runner and vite (docs/acceptance/P5.md Setup).
// Environment:
//   BASE            the web app (default http://127.0.0.1:5184)
//   RUNNER          the dev runner's id (default tdp5)
//   SCRATCH         a scratch project folder (default ~/.local/share/tdp5/projects/scratch)
//   CODEX_MODEL     the Codex model (default gpt-6-luna), effort Low
//   RESTART_RUNNER  a command that restarts the dev runner (for `restart`)
//   CRASH_RUNNER    a command that kill -9s the dev runner and starts it again (for `restartCrash`)
//   SHOTS           where screenshots go
// Steps (in order; later ones use the sessions earlier ones make):
//   home claude steer queue lostEdit stopSend terminal restart restartCrash codex restartCodex attach push inbox relay
// Every real turn is small. Sessions are only ever made in SCRATCH.

import { execFileSync } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const require = createRequire(new URL("../runner/package.json", import.meta.url));
const ece = require("http_ece");
const BASE = process.env.BASE ?? "http://127.0.0.1:5184";
const RUNNER = process.env.RUNNER ?? "tdp5";
const SHOTS = process.env.SHOTS ?? "/tmp/tether-e2e-p5";
const SCRATCH = process.env.SCRATCH ?? `${process.env.HOME}/.local/share/tdp5/projects/scratch`;
const CODEX_MODEL = process.env.CODEX_MODEL ?? "gpt-6-luna";
const RESTART = process.env.RESTART_RUNNER;
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const opts = new Map();
const newCtx = async (o) => {
  const c = await browser.newContext(o);
  opts.set(c, o);
  return c;
};
let desktop = await newCtx({ viewport: { width: 1280, height: 800 } });
let phone = await newCtx({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
const errors = [];
const page = async (ctx, url = BASE) => {
  // The dev server on a loaded machine now and then leaves a page blank: try again, then in a fresh
  // browser context (as a new device would).
  for (let i = 0; ; i++) {
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(String(e)));
    p.on("console", (m) => m.type() === "error" && console.log(`console error: ${m.text()}`));
    await p.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    if (await p.locator(".t-session, .t-inbox-head").first().waitFor({ timeout: 30_000 }).then(() => true, () => false)) return p;
    if (i >= 2) return p;
    await p.close();
    if (i === 1) {
      const fresh = await newCtx(opts.get(ctx));
      if (ctx === desktop) desktop = fresh;
      if (ctx === phone) phone = fresh;
      ctx = fresh;
    }
  }
};
const shot = (p, name) => p.screenshot({ path: `${SHOTS}/${name}.png` });
const ok = (msg) => console.log(`ok  ${msg}`);
const fail = (msg) => {
  throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noOverflow = async (p, where) => {
  const w = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (w > 1) fail(`${where}: page scrolls sideways by ${w}px`);
};
/**
 * The agent's own terminal UI (P5b): ❯_ opens the panel on a project shell; the agent's entry in its
 * list ("Claude Code", "Codex") is what drives the agent from its terminal.
 */
const pickTerminal = async (p, tap = false) => {
  const chip = p.locator(".t-chip-term");
  if ((await chip.getAttribute("aria-pressed")) !== "true") await (tap ? chip.tap() : chip.click());
  const entry = p.locator(".t-term-agent");
  await (tap ? entry.tap() : entry.click());
};
const composer = (p) => p.locator("textarea.t-input[aria-label=Message]");
const idle = (p, ms = 120_000) => p.locator('button[aria-label="Send"]').waitFor({ timeout: ms });
const running = (p, ms = 60_000) => p.locator('button[aria-label="Stop"], button[aria-label="Steer"], button[aria-label="Queue"]').first().waitFor({ timeout: ms });
async function send(p, text) {
  await composer(p).fill(text);
  await composer(p).press("Enter");
}
const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const MOD = (name) => `(performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/${name}")) ?? "/src/${name}")`;
const idOf = (url) => decodeURIComponent(url.split("/").pop());

/** The session's live state as the page has it. */
const liveState = (p) =>
  p.evaluate(async (store) => {
    const { useStore } = await import(eval(store));
    const id = decodeURIComponent(location.hash.split("/").pop());
    const v = Object.entries(useStore.getState().views).find(([k]) => k.endsWith(`\u0000${id}`))?.[1];
    return v?.state ?? null;
  }, MOD("store.ts"));
const waitState = async (p, pred, what, ms = 60_000) => {
  const end = Date.now() + ms;
  let st;
  while (Date.now() < end) {
    st = await liveState(p);
    if (st && pred(st)) return st;
    await sleep(300);
  }
  fail(`${what}: state is ${JSON.stringify(st && { mode: st.mode, status: st.status, queue: st.queue, queueHeldBy: st.queueHeldBy, requests: st.requests?.length })}`);
};
/** An op straight through the page's connection. */
const rpcVia = (p, op, args) =>
  p.evaluate(
    async ([runnerId, op, args, conn]) => {
      const { rpc } = await import(eval(conn));
      try {
        return { ok: await rpc(runnerId, op, args) };
      } catch (e) {
        return { error: e.message };
      }
    },
    [RUNNER, op, args, MOD("connection.ts")],
  );
/** A session's row as the page's summaries have it. */
const row = (p, id) =>
  p.evaluate(
    async ([store, runnerId, id]) => {
      const { useStore } = await import(eval(store));
      return useStore.getState().summaries[runnerId]?.sessions[id] ?? null;
    },
    [MOD("store.ts"), RUNNER, id],
  );
const transcriptText = (p) => p.locator(".t-scroll").innerText();
const userBubbles = (p) => p.locator(".t-msg.user .t-bubble").allInnerTexts();
const rendered = (p) => p.locator(".t-msg").allInnerTexts();
const waitText = async (p, re, what, ms = 120_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (re.test(await transcriptText(p).catch(() => ""))) return;
    await sleep(400);
  }
  fail(`${what}: the transcript doesn't match ${re}`);
};

async function newSession(p, harness) {
  if (!p.url().startsWith(BASE) || p.url().includes("/s/")) await p.goto(BASE);
  await p.getByRole("button", { name: "New session", exact: true }).first().click();
  const runnerSelect = p.locator(".t-form select.t-select", { has: p.locator(`option[value="${RUNNER}"]`) });
  if (await runnerSelect.count()) await runnerSelect.selectOption(RUNNER);
  if (harness === "codex") await p.getByRole("radio", { name: "Codex" }).click();
  await p.locator("#t-new-path").fill(SCRATCH);
  const model = harness === "codex" ? CODEX_MODEL : "haiku";
  await p.waitForFunction((m) => [...document.querySelectorAll(".t-form select option")].some((o) => o.value === m), model, { timeout: 120_000 });
  await p.locator(".t-form select.t-select", { has: p.locator(`option[value="${model}"]`) }).selectOption(model);
  await button(p, "Create").click();
  await p.waitForURL(new RegExp(`#/s/.*${harness}`), { timeout: 60_000 });
  const url = p.url();
  const id = idOf(url);
  if (harness === "codex") {
    const r = await rpcVia(p, "setEffort", { sessionId: id, effort: "low" });
    if (r.error) fail(`setEffort: ${r.error}`);
    await waitState(p, (s) => s.effort === "low", "effort low");
    // No approval prompts for `sleep` (only scratch threads run with this).
    await rpcVia(p, "setPermissionMode", { sessionId: id, mode: "full-access" });
  } else {
    // No tool prompts: these checks are about messaging, not approvals.
    const r = await rpcVia(p, "setPermissionMode", { sessionId: id, mode: "bypassPermissions" });
    if (r.error) fail(`setPermissionMode: ${r.error}`);
  }
  return url;
}


/** A small solid-color PNG (no encoder needed: stored deflate blocks). */
function png(w, h, [r, g, b]) {
  const { deflateSync } = require("node:zlib");
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A push service on this machine: records what runners send, decrypted with a device's keys. */
async function pushService() {
  const device = createECDH("prime256v1");
  device.generateKeys();
  const auth = randomBytes(16);
  const got = [];
  const server = createServer((req, res) => {
    const parts = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => {
      try {
        const plain = ece.decrypt(Buffer.concat(parts), { version: "aes128gcm", privateKey: device, authSecret: auth.toString("base64url") });
        got.push({ at: Date.now(), auth: req.headers.authorization, payload: JSON.parse(plain.toString()) });
      } catch (e) {
        got.push({ at: Date.now(), error: String(e) });
      }
      res.writeHead(201).end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${server.address().port}/push/e2e`;
  return { got, endpoint, keys: { p256dh: device.getPublicKey().toString("base64url"), auth: auth.toString("base64url") }, close: () => server.close() };
}
const waitPush = async (svc, pred, what, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = svc.got.find((g) => g.payload && pred(g.payload));
    if (hit) return hit;
    await sleep(250);
  }
  fail(`${what}: no such push (got ${JSON.stringify(svc.got.map((g) => g.payload ?? g.error))})`);
};
/** A page whose device id is `id` (so the runner knows it as that device). */
async function pageAs(ctx, id, url) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(BASE);
  await p.evaluate((id) => localStorage.setItem("tether.deviceId", id), id);
  await p.goto(url ?? BASE);
  await p.reload();
  return p;
}

/** A Claude session on a model that doesn't exist: its turns fail. */
async function brokenSession(p) {
  const r = await rpcVia(p, "newSession", { harness: "claude", projectPath: SCRATCH, model: "claude-no-such-model-1" });
  if (r.error) fail(`newSession: ${r.error}`);
  return r.ok.sessionId;
}

/** Waits until the agent is inside its slow command (its card shows, running), instead of a fixed pause. */
const inCommand = (p, re) => p.locator(".t-msg.assistant", { hasText: re }).last().waitFor({ timeout: 90_000 });

// Claude Code refuses a bare `sleep`; this waits the same.
const SLOW = (n, word) => `Use the Bash tool to run exactly: timeout ${n} tail -f /dev/null; echo waited   Then reply with exactly one word: ${word}`;

let claude; // the Claude session URL
let codex; // the Codex session URL

const steps = {
  async home() {
    for (const [ctx, name] of [
      [desktop, "desktop"],
      [phone, "phone"],
    ]) {
      const p = await page(ctx);
      await p.getByRole("heading", { name: "Home" }).waitFor({ timeout: 15_000 });
      await p.getByText("Notifications on this device").waitFor();
      await p.getByRole("heading", { name: "Runners" }).waitFor();
      await noOverflow(p, `home ${name}`);
      await shot(p, `home-${name}`);
      await p.close();
    }
    ok("Home is the landing page on desktop and phone: the inbox, then runners and this device's notifications");
  },

  async claude() {
    const p = await page(desktop);
    claude = await newSession(p, "claude");
    await composer(p).waitFor();
    ok(`new Claude (Haiku) session: ${idOf(claude)}`);
    await p.close();
  },

  async steer() {
    // Steer on Claude: Enter while a turn runs goes into that turn; both devices see it.
    const a = await page(desktop, claude);
    const b = await page(phone, claude);
    await composer(a).waitFor();
    await send(a, SLOW(12, "DONE"));
    await running(a);
    await waitState(a, (s) => s.status === "running", "running");
    await inCommand(a, /timeout 12 tail/);
    if (!/Enter to steer/.test(await composer(a).getAttribute("placeholder"))) fail("the composer doesn't offer steering");
    await composer(a).fill("After that, also reply with the word PINEAPPLE.");
    if ((await button(a, "Steer").count()) !== 1) fail("no Steer button with text in the box");
    await composer(a).press("Enter");
    await a.locator(".t-msg.user .t-bubble", { hasText: "PINEAPPLE" }).waitFor({ timeout: 15_000 });
    await b.locator(".t-msg.user .t-bubble", { hasText: "PINEAPPLE" }).waitFor({ timeout: 15_000 });
    await idle(a, 180_000);
    await waitText(a, /PINEAPPLE[\s\S]*$/, "the steer reached the turn");
    const last = (await a.locator(".t-msg.assistant").last().innerText()).toUpperCase();
    if (!/PINEAPPLE/.test(last) && !/PINEAPPLE/.test((await transcriptText(a)).split("After that, also")[1] ?? "")) fail(`Claude didn't act on the steer: ${last}`);
    await idle(b);
    await sleep(800);
    const [x, y] = [await rendered(a), await rendered(b)];
    if (JSON.stringify(x) !== JSON.stringify(y)) fail("desktop and phone transcripts differ after the steer");
    ok("Claude: Enter during a turn steered into it (Steer button, placeholder says so); shown on both devices; Claude acted on it");
    await a.close();
    await b.close();
  },

  async queue() {
    // The queue: Tab queues on desktop, the phone's menu queues too; both see it; edit, move and
    // cancel from either; after the turn they go out one per turn, in order.
    const a = await page(desktop, claude);
    const b = await page(phone, claude);
    await composer(a).waitFor();
    await send(a, SLOW(15, "FIRST"));
    await running(a);
    await inCommand(a, /timeout 15 tail/);
    await composer(a).fill("Reply with exactly: QUEUED-ONE");
    await composer(a).press("Tab");
    await a.locator(".t-queued", { hasText: "QUEUED-ONE" }).waitFor({ timeout: 10_000 });
    await b.locator(".t-queued", { hasText: "QUEUED-ONE" }).waitFor({ timeout: 10_000 });
    // The phone queues one through the menu.
    await composer(b).fill("Reply with exactly: QUEUED-TWO");
    await b.getByRole("button", { name: "More ways to send" }).tap();
    await b.getByRole("menuitem", { name: /Queue for after this turn/ }).tap();
    await a.locator(".t-queued", { hasText: "QUEUED-TWO" }).waitFor({ timeout: 10_000 });
    // A third, cancelled on the phone.
    await composer(a).fill("Reply with exactly: CANCELLED");
    await composer(a).press("Tab");
    await b.locator(".t-queued", { hasText: "CANCELLED" }).waitFor({ timeout: 10_000 });
    await b.locator(".t-queued", { hasText: "CANCELLED" }).getByRole("button", { name: "Cancel this message" }).tap();
    await a.locator(".t-queued", { hasText: "CANCELLED" }).waitFor({ state: "detached", timeout: 10_000 });
    // Edited on the phone, moved up on desktop.
    await b.locator(".t-queued", { hasText: "QUEUED-TWO" }).getByRole("button", { name: "Edit" }).tap();
    await b.getByRole("textbox", { name: "Edit the queued message" }).fill("Reply with exactly: QUEUED-2B");
    await button(b, "Save").tap();
    await a.locator(".t-queued", { hasText: "QUEUED-2B" }).waitFor({ timeout: 10_000 });
    await a.locator(".t-queued", { hasText: "QUEUED-2B" }).getByRole("button", { name: "Move up" }).click();
    await waitState(b, (s) => s.queue.map((m) => m.text).join("|") === "Reply with exactly: QUEUED-2B|Reply with exactly: QUEUED-ONE", "moved on the phone");
    await shot(a, "queue-desktop");
    await shot(b, "queue-phone");
    await noOverflow(b, "phone with a queue");
    // They go out one per turn, in order.
    await waitState(a, (s) => s.queue.length === 0 && s.status === "idle", "the queue drained", 240_000);
    await idle(a);
    const bubbles = await userBubbles(a);
    const tail = bubbles.slice(-3).join(" | ");
    if (!/FIRST[\s\S]*QUEUED-2B[\s\S]*QUEUED-ONE/.test(tail)) fail(`out of order: ${tail}`);
    const t = await transcriptText(a);
    if (/CANCELLED/.test(t)) fail("a cancelled message went out");
    if (!/QUEUED-2B[\s\S]*QUEUED-ONE/.test(t.slice(t.lastIndexOf("FIRST")))) fail("replies out of order");
    ok("queue: Tab (desktop) and the menu (phone) queued; both devices saw every change; cancelled, edited and moved from either; they went out one per turn in the new order");
    await a.close();
    await b.close();
  },

  async lostEdit() {
    // Editing a queued message as it goes out: the edit isn't lost; it can go as a new message or
    // into the message box. The queue doesn't wait for the edit.
    const a = await page(desktop, claude);
    await composer(a).waitFor();
    await send(a, SLOW(14, "EDIT"));
    await inCommand(a, /timeout 14 tail/);
    await composer(a).fill("Reply with exactly: ORIGINAL");
    await composer(a).press("Tab");
    const row = a.locator(".t-queued", { hasText: "ORIGINAL" });
    await row.waitFor();
    await row.getByRole("button", { name: "Edit" }).click();
    await a.getByRole("textbox", { name: "Edit the queued message" }).fill("Reply with exactly: EDITED");
    await a.getByText("It went out before your edit was saved.").waitFor({ timeout: 90_000 });
    await a.locator(".t-msg.user .t-bubble", { hasText: "ORIGINAL" }).waitFor({ timeout: 30_000 });
    await button(a, "Copy to the message box").click();
    if (!/EDITED/.test(await composer(a).inputValue())) fail("the edit didn't land in the message box");
    await composer(a).fill("");
    await idle(a, 120_000);
    // Again, and this time Send as a new message (the queue is empty by then).
    await send(a, SLOW(13, "EDIT2"));
    await inCommand(a, /timeout 13 tail/);
    await composer(a).fill("Reply with exactly: ORIGINAL-2");
    await composer(a).press("Tab");
    const row2 = a.locator(".t-queued", { hasText: "ORIGINAL-2" });
    await row2.waitFor();
    await row2.getByRole("button", { name: "Edit" }).click();
    await a.getByRole("textbox", { name: "Edit the queued message" }).fill("Reply with exactly: EDITED-2");
    await a.getByText("It went out before your edit was saved.").waitFor({ timeout: 90_000 });
    await idle(a, 120_000);
    await button(a, "Send as a new message").click();
    await a.locator(".t-msg.user .t-bubble", { hasText: "EDITED-2" }).waitFor({ timeout: 30_000 });
    if (await a.getByText("It went out before your edit was saved.").count()) fail("the panel stayed after sending");
    await idle(a, 120_000);
    ok("an edit of a queued message that went out first was kept (\"It went out before your edit was saved.\"); Copy to the message box put it there; Send as a new message (from an empty queue) sent it; the queue didn't wait");
    await a.close();
  },

  async stopSend() {
    // ⌘/Ctrl+Enter stops the turn and sends now; the queue waits for that turn, then goes on.
    const a = await page(desktop, claude);
    await composer(a).waitFor();
    await send(a, SLOW(30, "TOO-LATE"));
    await running(a);
    await inCommand(a, /timeout 30 tail/);
    await composer(a).fill("Reply with exactly: AFTER-NOW");
    await composer(a).press("Tab");
    await a.locator(".t-queued", { hasText: "AFTER-NOW" }).waitFor();
    await composer(a).fill("Reply with exactly: NOW");
    await composer(a).press("Control+Enter");
    await a.locator(".t-msg.user .t-bubble", { hasText: "Reply with exactly: NOW" }).waitFor({ timeout: 20_000 });
    await waitState(a, (s) => s.queue.length === 0 && s.status === "idle", "the queue went on after NOW", 120_000);
    await idle(a);
    const t = await transcriptText(a);
    const tail = t.slice(t.lastIndexOf("TOO-LATE"));
    if (!/NOW[\s\S]*AFTER-NOW/.test(tail)) fail(`order after stop-and-send: ${tail.slice(0, 400)}`);
    // Stop alone holds the queue until you send or resume.
    await send(a, SLOW(31, "STOPPED"));
    await running(a);
    await inCommand(a, /timeout 31 tail/);
    await composer(a).fill("Reply with exactly: HELD");
    await composer(a).press("Tab");
    await a.locator(".t-queued", { hasText: "HELD" }).waitFor();
    await composer(a).press("Escape");
    await waitState(a, (s) => s.status === "idle" && s.queueHeldBy === "stopped", "held after Stop", 30_000);
    await a.locator(".t-queue", { hasText: "Paused after Stop" }).waitFor();
    await sleep(2000);
    if ((await liveState(a)).queue.length !== 1) fail("the held queue went out");
    await button(a.locator(".t-queue"), "Resume").click();
    await waitState(a, (s) => s.queue.length === 0, "resumed", 30_000);
    await idle(a);
    ok("Ctrl+Enter stopped the running turn and sent at once; the queued message followed that turn. Stop (Esc) held the queue; Resume sent it");
    await a.close();
  },

  async terminal() {
    // A handoff holds the queue; Back to Tether releases it.
    const a = await page(desktop, claude);
    await composer(a).waitFor();
    await send(a, SLOW(20, "HANDOFF"));
    await running(a);
    await inCommand(a, /timeout 20 tail/);
    await composer(a).fill("Reply with exactly: AFTER-TERMINAL");
    await composer(a).press("Tab");
    await a.locator(".t-queued", { hasText: "AFTER-TERMINAL" }).waitFor();
    await pickTerminal(a);
    const ask = a.locator(".t-term-ask");
    await ask.waitFor();
    const q = await ask.innerText();
    if (!/1 queued message will wait/.test(q)) fail(`the handoff question: ${q}`);
    await button(ask, "Stop and open terminal").click();
    await waitState(a, (s) => s.mode === "terminal" && s.queueHeldBy === "terminal", "in the terminal, queue held", 60_000);
    await a.locator(".t-queue", { hasText: "back from the terminal" }).waitFor();
    // Tab while the TUI drives queues too, held with the rest (SPEC §8).
    await composer(a).fill("Reply with exactly: TAB-IN-TERMINAL");
    await composer(a).press("Tab");
    await a.locator(".t-queued", { hasText: "TAB-IN-TERMINAL" }).waitFor({ timeout: 10_000 });
    await sleep(4000);
    const held = await liveState(a);
    if (held.queue.length !== 2 || held.queueHeldBy !== "terminal") fail(`the queue in the terminal: ${JSON.stringify(held.queue.map((m) => m.text))} ${held.queueHeldBy}`);
    await button(a, "Back to Tether").first().click();
    await waitState(a, (s) => s.mode === "live" && s.queue.length <= 1, "back live and the queue going out", 90_000);
    await a.locator(".t-msg.user .t-bubble", { hasText: "AFTER-TERMINAL" }).waitFor({ timeout: 30_000 });
    await waitState(a, (s) => s.queue.length === 0 && s.status === "idle", "both held messages sent", 180_000);
    await a.locator(".t-msg.user .t-bubble", { hasText: "TAB-IN-TERMINAL" }).waitFor({ timeout: 10_000 });
    await idle(a);
    ok("terminal handoff with a queued message: asked first (\"1 queued message will wait\"), held while the TUI drove (Tab there queued another, held too), both sent after Back to Tether");
    await a.close();
  },

  async restart() {
    // A runner restart mid-turn: the turn goes on by itself (Tether's own continue message), and the
    // queued message follows it, never held.
    if (!RESTART) return console.log("skip restart (set RESTART_RUNNER)");
    const a = await page(desktop, claude);
    await composer(a).waitFor();
    await send(a, SLOW(25, "CUT"));
    await running(a);
    await inCommand(a, /timeout 25 tail/);
    await composer(a).fill("Reply with exactly: SURVIVED");
    await composer(a).press("Tab");
    await a.locator(".t-queued", { hasText: "SURVIVED" }).waitFor();
    execFileSync("sh", ["-c", RESTART], { stdio: "inherit" });
    const b = await page(phone, claude);
    await b.getByText("The Tether runner restarted mid-turn; continuing.").waitFor({ timeout: 90_000 });
    await b.locator(".t-msg.from", { hasText: "Tether: continue after restart" }).waitFor({ timeout: 90_000 });
    await shot(b, "restart-continues-phone");
    const held = await liveState(b);
    if (held?.queueHeldBy === "restart") fail("the queue was held after an automatic continue");
    await b.locator(".t-msg.user .t-bubble", { hasText: "SURVIVED" }).waitFor({ timeout: 180_000 });
    await waitState(b, (s) => s.queue.length === 0 && s.status === "idle", "the queued message after the continue", 180_000);
    if ((await row(b, idOf(claude)))?.unread === "failed") fail("Home says Failed for a continued turn");
    ok("runner restarted mid-turn: Claude's turn went on by itself (Tether's notice and its continue message), and the queued message followed it, never held");
    await a.close();
    await b.close();
  },

  async restartCrash() {
    // kill -9 the runner mid-turn (no systemd here, so Claude Code from before is left running): the
    // new runner waits for the session's store to be quiet before anything continues, so two Claude
    // processes never write the session at once.
    const CRASH = process.env.CRASH_RUNNER;
    if (!CRASH) return console.log("skip restartCrash (set CRASH_RUNNER)");
    const a = await page(desktop, claude);
    await composer(a).waitFor();
    // Several short commands one after another: the left-behind process keeps writing for a while.
    await send(a, "Use the Bash tool five times, one call after another (not combined): run exactly `timeout 4 tail -f /dev/null; echo step` each time. Then reply with exactly one word: STEPS");
    await running(a);
    await inCommand(a, /timeout 4 tail/);
    const id = idOf(claude);
    const { realpathSync, statSync, readdirSync } = await import("node:fs");
    const enc = realpathSync(SCRATCH).replace(/[^a-zA-Z0-9]/g, "-");
    const base = `${process.env.HOME}/.claude/projects`;
    const dir = readdirSync(base).find((d) => d === enc) ?? enc;
    const file = `${base}/${dir}/${id.split(":")[1]}.jsonl`;
    const mtimes = [];
    let stop = false;
    const watch = (async () => {
      while (!stop) {
        try {
          const m = statSync(file).mtimeMs;
          if (mtimes.at(-1) !== m) mtimes.push(m);
        } catch {}
        await sleep(200);
      }
    })();
    execFileSync("sh", ["-c", CRASH], { stdio: "inherit" });
    const b = await page(desktop, claude);
    // Either Tether waits for the left-behind process, then (its turn finished) doesn't continue, or
    // (it stopped mid-turn) continues once the store is quiet.
    const continued = b.locator(".t-msg.from", { hasText: "Tether: continue after restart" });
    const end = Date.now() + 240_000;
    let at;
    while (Date.now() < end) {
      if (await continued.count()) {
        at = Date.now();
        break;
      }
      const st = await liveState(b);
      if (st && st.status === "idle" && /STEPS/.test(await transcriptText(b)) && !(await b.getByText("Waiting for Claude Code from before the restart").count())) break;
      if (st && st.status === "idle" && /STEPS/.test(await transcriptText(b))) break;
      await sleep(500);
    }
    stop = true;
    await watch;
    if (at) {
      // The continue went out only after the store had been quiet for a while (none of its writes in
      // the 12 s before it, its own aside).
      const before = mtimes.filter((m) => m < at - 1500);
      const last = before.at(-1) ?? 0;
      if (at - last < 12_000) fail(`the continue went out ${Math.round((at - last) / 1000)} s after the store last changed: two processes may have overlapped`);
    }
    await shot(b, "restart-crash");
    await idle(b, 240_000);
    ok(`runner killed (-9) mid-turn: ${at ? "Tether waited for the session's store to go quiet, then continued once" : "Tether waited for Claude Code from before the restart, which finished the turn; nothing was continued"} — never two processes at once`);
    await a.close();
    await b.close();
  },

  async codex() {
    const p = await page(desktop);
    codex = await newSession(p, "codex");
    const b = await page(phone, codex);
    await composer(p).waitFor();
    await send(p, "Use the shell to run exactly: sleep 12   Then reply with exactly one word: DONE");
    await running(p);
    await waitState(p, (s) => s.status === "running", "running");
    await inCommand(p, /sleep 12/);
    await composer(p).fill("When you reply, also include the word PINEAPPLE.");
    await composer(p).press("Enter");
    // Codex shows a steer when the model takes it (after the running command).
    await b.locator(".t-msg.user .t-bubble", { hasText: "PINEAPPLE" }).waitFor({ timeout: 120_000 });
    await composer(b).fill("Reply with exactly: CODEX-QUEUED");
    await b.getByRole("button", { name: "More ways to send" }).tap();
    await b.getByRole("menuitem", { name: /Queue for after this turn/ }).tap();
    await p.locator(".t-queued", { hasText: "CODEX-QUEUED" }).waitFor({ timeout: 10_000 });
    await waitState(p, (s) => s.queue.length === 0 && s.status === "idle", "the Codex queue drained", 240_000);
    await idle(p);
    const t = await transcriptText(p);
    if (!/PINEAPPLE/i.test(t.slice(t.indexOf("When you reply")))) fail("Codex didn't act on the steer");
    if (!/CODEX-QUEUED[\s\S]*CODEX-QUEUED/.test(t)) fail("the queued message didn't go out (or wasn't answered)");
    ok("Codex: steered into the running turn from desktop, queued from the phone; the queued message went out after the turn");
    await p.close();
    await b.close();
  },

  async restartCodex() {
    // Codex keeps the turn going in its daemon: the runner just rejoins; Tether sends nothing of its own.
    if (!RESTART || !codex) return console.log("skip restartCodex (set RESTART_RUNNER; needs the codex step)");
    const a = await page(desktop, codex);
    await composer(a).waitFor();
    await send(a, "Use the shell to run exactly: sleep 20   Then reply with exactly one word: KEPT");
    await running(a);
    await inCommand(a, /sleep 20/);
    await composer(a).fill("Reply with exactly: CODEX-AFTER");
    await composer(a).press("Tab");
    await a.locator(".t-queued", { hasText: "CODEX-AFTER" }).waitFor();
    execFileSync("sh", ["-c", RESTART], { stdio: "inherit" });
    const b = await page(desktop, codex);
    await b.locator(".t-msg.user .t-bubble", { hasText: "CODEX-AFTER" }).waitFor({ timeout: 240_000 });
    await waitState(b, (s) => s.queue.length === 0 && s.status === "idle", "Codex's queue after the rejoin", 240_000);
    if (/Tether: continue after restart/.test(await transcriptText(b))) fail("Tether sent a continue to Codex, whose turn went on");
    ok("Codex: the turn kept running in the daemon through the restart; the runner rejoined it (no continue message) and the queued message followed");
    await a.close();
    await b.close();
  },

  async attach() {
    // From the phone: a photo (the camera input) and a text file, to each harness. Each harness reads
    // both, and the transcript shows the image and the file's chip.
    const red = `${SHOTS}/red.png`;
    writeFileSync(red, png(96, 96, [220, 20, 20]));
    const secret = `${SHOTS}/secret.txt`;
    writeFileSync(secret, "The secret word is MANGO.\n");
    for (const [url, who] of [
      [claude, "Claude"],
      [codex, "Codex"],
    ]) {
      if (!url) continue;
      const p = await page(phone, url);
      await composer(p).waitFor();
      await p.locator('input[type=file][aria-label="Take a photo"]').setInputFiles(red);
      await p.locator('input[type=file][aria-label="Attach files"]').setInputFiles(secret);
      await p.waitForFunction(() => {
        const chips = [...document.querySelectorAll(".t-files .t-file .t-file-meta")].map((e) => e.textContent);
        return chips.length === 2 && chips.every((c) => /B$/.test(c ?? ""));
      }, null, { timeout: 30_000 });
      await shot(p, `attach-${who}-composer`);
      await composer(p).fill("What color is the attached image, and what is the secret word in the attached text file? Reply as: COLOR WORD");
      await button(p, "Send").tap();
      await p.locator(".t-msg.user img.t-img").last().waitFor({ timeout: 30_000 });
      await p.locator(".t-msg.user .t-msg-files .t-file", { hasText: "secret.txt" }).last().waitFor();
      await idle(p, 180_000);
      const reply = (await p.locator(".t-msg.assistant").last().innerText()).toUpperCase().trim().split("\n").pop();
      if (!/RED/.test(reply) || !/MANGO/.test(reply)) fail(`${who} replied: ${reply}`);
      await noOverflow(p, "phone with attachments");
      await shot(p, `attach-${who}-sent`);
      // The stored transcript shows the same (a fresh open reads it again).
      const d = await page(desktop, url);
      await d.locator(".t-msg.user img.t-img").last().waitFor({ timeout: 30_000 });
      await d.locator(".t-msg.user .t-msg-files .t-file", { hasText: "secret.txt" }).last().waitFor();
      ok(`attachments from the phone (camera photo + a file) reached ${who}: it answered "${reply.trim().slice(0, 60)}"; the image and the file chip show on phone and desktop`);
      await p.close();
      await d.close();
    }
  },

  async push() {
    // Push, headless: a device subscription on the runner pointing at a local push service; a test,
    // then a request, a finish and a failure each arrive (decrypted with the device's keys); a device
    // looking at the session gets nothing; the service worker shows a pushed notification and its
    // click opens the session.
    const svc = await pushService();
    const home = await page(desktop);
    await home.getByRole("heading", { name: "Home" }).waitFor();
    const sub = await rpcVia(home, "pushSubscribe", { deviceId: "e2e-device", subscription: { endpoint: svc.endpoint, keys: svc.keys }, label: "e2e" });
    if (sub.error) fail(`pushSubscribe: ${sub.error}`);
    const st = await rpcVia(home, "pushStatus", { endpoint: svc.endpoint });
    if (!st.ok?.subscribed || !st.ok?.ready) fail(`pushStatus: ${JSON.stringify(st)}`);
    const t = await rpcVia(home, "pushTest", { endpoint: svc.endpoint });
    if (t.error) fail(`pushTest: ${t.error}`);
    const test = await waitPush(svc, (p) => p.kind === "test", "test push");
    if (!/^vapid t=.*k=/.test(test.auth ?? "")) fail(`no VAPID authorization: ${test.auth}`);
    const id = idOf(claude);
    // A request.
    await rpcVia(home, "setPermissionMode", { sessionId: id, mode: "default" });
    await rpcVia(home, "send", { sessionId: id, text: "Use the Bash tool to run exactly: echo push > push.txt   Then reply with exactly: PUSHED" });
    const req = await waitPush(svc, (p) => p.kind === "request" && p.sessionId === id, "request push", 90_000);
    // Why it needs you, never the command itself.
    if (req.payload.body !== "Claude wants to run a command.") fail(`request body: ${req.payload.body}`);
    if (!/^[\w.-]+ · Claude$/.test(req.payload.title)) fail(`request title: ${req.payload.title}`);
    const open = await rpcVia(home, "subscribe", { sessionId: id });
    const r = open.ok.state.requests[0];
    await rpcVia(home, "answerRequest", { sessionId: id, requestId: r.id, allow: true });
    // The finish.
    const fin = await waitPush(svc, (p) => p.kind === "finished" && p.sessionId === id, "finished push", 120_000);
    if (fin.payload.body !== "Finished." || /PUSHED/.test(JSON.stringify(fin.payload))) fail(`finished push: ${JSON.stringify(fin.payload)}`);
    await rpcVia(home, "setPermissionMode", { sessionId: id, mode: "bypassPermissions" });
    // A failure: a session on a model that doesn't exist.
    const broken = await brokenSession(home);
    await rpcVia(home, "send", { sessionId: broken, text: "Reply with exactly: NEVER" });
    const failed = await waitPush(svc, (p) => p.kind === "failed" && p.sessionId === broken, "failed push", 120_000);
    if (failed.payload.body !== "Failed: model unavailable.") fail(`failed push: ${failed.payload.body}`);
    if (svc.got.some((g) => /claude-no-such-model/.test(JSON.stringify(g.payload ?? {})))) fail("a push carried the raw error");
    await rpcVia(home, "unsubscribe", { sessionId: id });
    ok(`push: test, request ("${req.payload.body}"), finished ("${fin.payload.body}") and failed ("${failed.payload.body}") reached a device's push service, VAPID-signed, decrypting with its keys`);
    // A device looking at the session isn't told; once it looks away, it is.
    const looking = await pageAs(desktop, "e2e-device", claude);
    await composer(looking).waitFor();
    await sleep(1500);
    const before = svc.got.length;
    await send(looking, "Reply with exactly: WATCHED");
    await idle(looking);
    await sleep(4000);
    const seen = svc.got.slice(before).filter((g) => g.payload?.sessionId === id);
    if (seen.length) fail(`a device looking at the session was notified: ${JSON.stringify(seen.map((g) => g.payload))}`);
    await looking.goto(`${BASE}/#/`);
    await sleep(1000);
    await rpcVia(home, "send", { sessionId: id, text: "Reply with exactly: AWAY" });
    const n0 = svc.got.length;
    await waitPush(svc, (p) => p.kind === "finished" && p.sessionId === id && svc.got.indexOf(svc.got.find((g) => g.payload === p)) >= n0, "finished push after looking away", 120_000);
    ok("a device looking at the session got no push for it; after it went Home, it did");
    await looking.close();
    await rpcVia(home, "pushUnsubscribe", { endpoint: svc.endpoint });
    if ((await rpcVia(home, "pushStatus", { endpoint: svc.endpoint })).ok?.subscribed) fail("still subscribed after pushUnsubscribe");
    svc.close();
    await home.close();

    // The service worker: a push shows a notification; its click opens the session in the open window.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.grantPermissions(["notifications"], { origin: BASE });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(BASE);
    await p.getByRole("heading", { name: "Home" }).waitFor();
    await p.evaluate(() => navigator.serviceWorker.ready);
    const cdp = await ctx.newCDPSession(p);
    const regs = [];
    cdp.on("ServiceWorker.workerRegistrationUpdated", (e) => regs.push(...e.registrations));
    await cdp.send("ServiceWorker.enable");
    await sleep(500);
    const reg = regs.find((r) => r.scopeURL.startsWith(BASE));
    if (!reg) fail("no service worker registration");
    // The switch: the real subscribe needs a push service the headless browser may not have.
    const turnOn = p.getByRole("button", { name: "Turn on" });
    let subscribeNote = "skipped";
    if (await turnOn.count()) {
      await turnOn.click();
      await sleep(3000);
      subscribeNote = (await p.locator(".t-notify").innerText()).replace(/\s+/g, " ");
    }
    // Headless Chromium never grants notifications to a service worker, so showNotification is
    // recorded instead of shown (the push handler and its payload are the real ones).
    const [worker] = ctx.serviceWorkers();
    if (!worker) fail("no service worker");
    await worker.evaluate(() => {
      self.__shown = [];
      self.registration.showNotification = async (title, options) => void self.__shown.push({ title, options });
    });
    const payload = { kind: "finished", title: "SW check", body: "Opened from a notification", runnerId: RUNNER, sessionId: id, tag: "e2e", ts: Date.now() };
    await cdp.send("ServiceWorker.deliverPushMessage", { origin: new URL(BASE).origin, registrationId: reg.registrationId, data: JSON.stringify(payload) });
    let shown = [];
    for (let i = 0; i < 40 && !shown.length; i++) {
      await sleep(250);
      shown = await worker.evaluate(() => self.__shown);
    }
    if (!shown.length) fail("the service worker showed no notification for a push");
    if (shown[0].title !== "SW check" || !shown[0].options.data?.url?.includes(encodeURIComponent(id))) fail(`notification: ${JSON.stringify(shown[0])}`);
    // The click, as the browser would deliver it for that notification.
    await worker.evaluate((data) => {
      const e = new Event("notificationclick");
      Object.defineProperty(e, "notification", { value: { data, close() {} } });
      Object.defineProperty(e, "waitUntil", { value: (p) => p });
      self.dispatchEvent(e);
    }, shown[0].options.data);
    await p.waitForURL((u) => decodeURIComponent(u.toString()).includes(`/s/${RUNNER}/${id}`), { timeout: 10_000 });
    await composer(p).waitFor({ timeout: 30_000 });
    ok(`service worker: a delivered push showed "${shown[0].title}"; clicking it opened the session in the open window. Turn on in headless Chromium: ${subscribeNote}`);
    await ctx.close();
  },

  async inbox() {
    // Home's inbox across devices: a turn that ends while nobody looks shows as Finished on both;
    // opening it on the phone clears it on desktop; a failed turn shows its error; Mark read syncs.
    const id = idOf(claude);
    const a = await page(desktop);
    const b = await page(phone);
    await a.getByRole("heading", { name: "Home" }).waitFor();
    await rpcVia(a, "send", { sessionId: id, text: "Reply with exactly: INBOX" });
    const rowOf = (p) => p.locator(".t-inbox-row", { has: p.locator(".t-row-title") }).filter({ hasText: "Finished" });
    for (let i = 0; i < 240 && (await row(a, id))?.unread !== "finished"; i++) await sleep(500);
    if ((await row(a, id))?.unread !== "finished") fail("the row isn't unread");
    const title0 = (await row(a, id)).title;
    await a.locator(".t-inbox-row.finished .t-inbox-main", { hasText: title0 }).first().waitFor({ timeout: 10_000 });
    await b.locator(".t-inbox-row.finished .t-inbox-main", { hasText: title0 }).first().waitFor({ timeout: 10_000 });
    await shot(a, "inbox-desktop");
    await shot(b, "inbox-phone");
    await noOverflow(b, "phone inbox");
    // Opened on the phone: read everywhere.
    const title = (await row(a, id)).title;
    await b.locator(".t-inbox-row.finished .t-inbox-main", { hasText: title }).first().tap();
    await composer(b).waitFor();
    for (let i = 0; i < 40 && (await row(a, id))?.unread; i++) await sleep(250);
    if ((await row(a, id))?.unread) fail("opening it on the phone didn't mark it read on desktop");
    await b.goto(`${BASE}/#/`);
    // A failure, and Mark read on desktop.
    const broken = await brokenSession(a);
    await rpcVia(a, "send", { sessionId: broken, text: "Reply with exactly: NEVER" });
    const failedRow = (p) => p.locator(`.t-inbox-row.failed[data-session="${broken}"]`);
    await failedRow(a).waitFor({ timeout: 120_000 });
    const why = await failedRow(a).locator(".t-inbox-why").innerText();
    await failedRow(b).waitFor({ timeout: 10_000 });
    await failedRow(a).getByRole("button", { name: /^Mark .* read$/ }).click();
    await failedRow(b).waitFor({ state: "detached", timeout: 10_000 });
    ok(`inbox: Finished on desktop and phone; opened on the phone, read on desktop; a failed turn ("${why.slice(0, 60)}") showed on both; Mark read on desktop cleared it on the phone`);
    void rowOf;
    await a.close();
    await b.close();
  },

  async relay() {
    // A message to a running Claude subagent goes through the main agent's SendMessage, shows in the
    // subagent's view as yours ("Sent via the main agent"), and reaches the subagent.
    const a = await page(desktop, claude);
    await composer(a).waitFor();
    await send(
      a,
      'Use the Agent tool with run_in_background set to true, subagent_type "general-purpose", description "Waiting helper", and this prompt: "Run the Bash command: timeout 45 tail -f /dev/null; echo waited. Then reply with every message you received from the main agent while you waited, word for word." Then wait for it to finish and tell me exactly what it replied.',
    );
    const kid = await waitState(a, () => true, "x", 1).catch(() => null);
    void kid;
    let child;
    for (let i = 0; i < 240 && !child; i++) {
      await sleep(500);
      child = await a.evaluate(
        async ([store, runnerId, parent]) => {
          const { useStore } = await import(eval(store));
          return Object.values(useStore.getState().summaries[runnerId]?.sessions ?? {}).find((s) => s.parentSessionId === parent && s.status === "running")?.id;
        },
        [MOD("store.ts"), RUNNER, idOf(claude)],
      );
    }
    if (!child) fail("no running subagent");
    const c = await page(desktop, `${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(child)}`);
    await composer(c).waitFor({ timeout: 30_000 });
    await sleep(4000);
    await composer(c).fill("The code word is KUMQUAT.");
    await composer(c).press("Enter");
    const bubble = c.locator(".t-msg.user", { hasText: "The code word is KUMQUAT." });
    await bubble.waitFor({ timeout: 15_000 });
    await bubble.locator(".t-relay").waitFor();
    await c.locator(".t-relay.delivered").waitFor({ timeout: 90_000 });
    await shot(c, "relay-subagent");
    await idle(a, 240_000);
    const t = await transcriptText(a);
    if (!/KUMQUAT/.test(t.slice(t.lastIndexOf("Waiting helper")))) fail("the subagent's reply (in the main session) doesn't carry the code word");
    ok("Claude subagent steered via the main agent: shown in the subagent's view as yours, marked Sent via the main agent once its SendMessage call was seen; the subagent got it (its reply has the code word)");
    await a.close();
    await c.close();
  },
};

const order = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(steps);
let failed = 0;
for (const name of order) {
  if (!steps[name]) {
    console.log(`no step ${name}`);
    failed++;
    continue;
  }
  try {
    await steps[name]();
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
    for (const p of [...desktop.pages(), ...phone.pages()]) await shot(p, `fail-${name}-${Math.random().toString(36).slice(2, 6)}`).catch(() => {});
    for (const p of [...desktop.pages(), ...phone.pages()]) await p.close().catch(() => {});
    if (["claude", "codex"].includes(name)) break;
  }
}
if (errors.length) console.log(`page errors:\n${errors.join("\n")}`);
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
