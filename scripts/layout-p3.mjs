// The terminal panel's layout (P3.md G5, G5b, D1, B3) against a local dev stack, in Chromium:
//   PLAYWRIGHT=/path/to/playwright/index.mjs node scripts/layout-p3.mjs [step…]
// Opens a real Claude TUI in a new session and sends nothing to the model. Same stack and environment
// as e2e-p3.mjs: BASE, RUNNER, SCRATCH (a folder Claude already trusts), TMUX_SOCKET, SHOTS.
// Steps: g5 rotate beside sidebar panel stored hidden ask placeholder (all by default).
// Exits 1 on any problem found.

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const BASE = process.env.BASE ?? "http://127.0.0.1:5182";
const RUNNER = process.env.RUNNER ?? "tether-dev-p3";
const SOCKET = process.env.TMUX_SOCKET ?? "tether-dev-p3";
const SHOTS = process.env.SHOTS ?? "/tmp/tether-layout-p3";
const SCRATCH = process.env.SCRATCH ?? `${process.env.HOME}/.local/share/tether-dev-p3/projects/scratch`;
mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const check = (ok, what) => {
  if (ok) return;
  bad++;
  console.log(`  !! ${what}`);
};
const tmux = (...a) => spawnSync("tmux", ["-L", SOCKET, ...a], { encoding: "utf8" }).stdout ?? "";

// The app's own socket, through vite.
const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/ws`);
await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.t !== "result") return;
  pending.get(m.id)?.(m);
  pending.delete(m.id);
};
await sleep(500);
const rpc = (op, args) =>
  new Promise((res, rej) => {
    const id = String(++seq);
    pending.set(id, (m) => (m.ok ? res(m.data) : rej(new Error(m.error))));
    ws.send(JSON.stringify({ t: "rpc", id, runnerId: RUNNER, op, args }));
  });

/** What the layout is now, in whole pixels. */
const measure = (p) =>
  p.evaluate(() => {
    const r = (e) => {
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) };
    };
    const q = (s) => r(document.querySelector(s));
    const panel = document.querySelector(".t-term-panel");
    const button = (name) => r([...(panel?.querySelectorAll("button") ?? [])].find((x) => x.textContent.trim() === name || x.getAttribute("aria-label") === name));
    const term = [...(globalThis.__tetherTerms?.entries() ?? [])].find(([k]) => k.startsWith("claude:"))?.[1];
    const stored = (k) => localStorage.getItem(`tether.width.${k}`);
    return {
      vw: innerWidth,
      vh: innerHeight,
      scroll: document.documentElement.scrollWidth,
      cover: !!document.querySelector(".t-term-cover"),
      hidden: !!panel?.classList.contains("hidden"),
      panel: q(".t-term-panel"),
      session: q(".t-session"),
      side: q(".t-side-frame"),
      back: button("Back to Tether"),
      x: button("Close terminal panel"),
      chat: button("Chat"),
      ret: q(".t-term-return"),
      keys: [...document.querySelectorAll(".t-key")].map(r),
      cols: term?.cols,
      rows: term?.rows,
      font: term?.options.fontSize,
      focused: !!document.activeElement?.closest?.(".t-term-box"),
      storedPanel: stored("panel"),
      storedSide: stored("sidebar"),
    };
  });
const on = (b, m) => !!b && b.l >= 0 && b.t >= 0 && b.r <= m.vw && b.b <= m.vh;

const browser = await chromium.launch();
const sessions = [];
let tui;
let current;

const url = (id) => `${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`;
const newTui = async () => {
  const { sessionId } = await rpc("newSession", { harness: "claude", projectPath: SCRATCH, model: "haiku", permissionMode: "default", terminal: true });
  sessions.push(sessionId);
  tui = `t-${sessionId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  await sleep(4000);
  return sessionId;
};
const open = async (o, init) => {
  const ctx = await browser.newContext(o);
  if (init) await ctx.addInitScript(init);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => check(false, `page error: ${String(e).slice(0, 200)}`));
  await p.goto(url(current));
  await p.locator(".t-term-banner").getByRole("button", { name: "Open Claude Code" }).click({ timeout: 30_000 });
  await p.locator(".t-term-panel").waitFor();
  await sleep(2000);
  return { ctx, p };
};
const win = () => tmux("display", "-p", "-t", `=${tui}:`, "#{window_width}x#{window_height}").trim();
const phone = (width, height) => ({ viewport: { width, height }, hasTouch: true, isMobile: true });
const panelButton = (p, name) => p.locator(".t-term-panel").getByRole("button", { name, exact: true });

const STEPS = {
  /** G5: every size has no room beside the transcript. */
  async g5() {
    for (const [w, h] of [[844, 390], [896, 414], [932, 430], [768, 1024], [1024, 768], [1024, 700], [667, 375]]) {
      const { ctx, p } = await open(phone(w, h));
      const m = await measure(p);
      const at = `${w}x${h}`;
      console.log(at, JSON.stringify({ cover: m.cover, cols: m.cols, rows: m.rows, font: m.font, focused: m.focused, win: win() }));
      check(m.cover, `${at}: not over the chat`);
      check(m.panel?.r - m.panel?.l === w, `${at}: the panel isn't full width`);
      check(on(m.back, m) && on(m.x, m) && on(m.chat, m), `${at}: Back to Tether, × or Chat off screen`);
      check(m.scroll <= m.vw, `${at}: scrolls sideways`);
      check(m.keys.every((k) => on(k, m)), `${at}: a key off screen`);
      check(m.font === (w < 768 ? 11 : 13), `${at}: font ${m.font}`);
      check(win() === `${m.cols}x${m.rows}`, `${at}: tmux ${win()} vs ${m.cols}x${m.rows}`);
      check(!m.focused, `${at}: a touch screen's terminal took the focus unasked (the keyboard would rise)`);
      await panelButton(p, "Chat").click();
      await sleep(300);
      const c = await measure(p);
      check(c.hidden, `${at}: Chat didn't tuck it away`);
      check(c.session?.r === w, `${at}: the chat doesn't take the room the panel left`);
      await p.screenshot({ path: `${SHOTS}/g5-${at}.png` });
      await ctx.close();
    }
  },
  /** Rotation: the same page refits, the font follows, tmux's window with it. */
  async rotate() {
    for (const [w, h] of [[390, 844], [844, 390], [1024, 1366]]) {
      const { ctx, p } = await open(phone(w, h));
      for (const [w2, h2] of [[h, w], [w, h]]) {
        await p.setViewportSize({ width: w2, height: h2 });
        await sleep(1200);
        const r = await measure(p);
        const at = `${w}x${h} to ${w2}x${h2}`;
        console.log(at, JSON.stringify({ cover: r.cover, cols: r.cols, rows: r.rows, font: r.font, win: win() }));
        check(r.font === (w2 < 768 ? 11 : 13), `${at}: font ${r.font}`);
        check(win() === `${r.cols}x${r.rows}`, `${at}: tmux ${win()} vs ${r.cols}x${r.rows}`);
        check(on(r.back, r) && on(r.x, r), `${at}: Back to Tether or × off screen`);
        check(r.keys.every((k) => on(k, r)), `${at}: a key off screen`);
      }
      await ctx.close();
    }
  },
  /** Beside the transcript the panel has 60 columns and the transcript 300 px, at any scale. */
  async beside() {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      const { ctx, p } = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr });
      for (let w = 1260; w >= 1150; w -= 10) {
        await p.setViewportSize({ width: w, height: 800 });
        await sleep(300);
        const m = await measure(p);
        if (m.cover) continue;
        check(m.cols >= 60, `dpr ${dpr}, ${w} px: ${m.cols} columns beside`);
        check(m.session.r - m.session.l >= 300, `dpr ${dpr}, ${w} px: transcript ${m.session.r - m.session.l}`);
      }
      await ctx.close();
    }
  },
  /** The sidebar dragged wide takes the room: the panel goes over the chat, and back. */
  async sidebar() {
    const { ctx, p } = await open({ viewport: { width: 1280, height: 800 } });
    const handle = p.locator('[aria-label="Resize sidebar"]');
    const bx = await handle.boundingBox();
    const [x, y] = [bx.x + bx.width / 2, bx.y + bx.height / 2];
    await p.mouse.move(x, y);
    await p.mouse.down();
    await p.mouse.move(x + 240, y, { steps: 6 });
    await sleep(300);
    await p.mouse.move(x, y, { steps: 6 });
    await p.mouse.up();
    await sleep(600);
    check(!(await measure(p)).cover, "the sidebar dragged out and back left the panel over the chat");
    await p.evaluate(() => localStorage.removeItem("tether.width.sidebar"));
    await ctx.close();
  },
  /** The panel's handle stops at 60 columns and at a 300 px transcript. */
  async panel() {
    const { ctx, p } = await open({ viewport: { width: 1440, height: 900 } });
    const bx = await p.locator(".t-term-handle").first().boundingBox();
    const [x, y] = [bx.x + bx.width / 2, bx.y + 200];
    await p.mouse.move(x, y);
    await p.mouse.down();
    await p.mouse.move(x + 600, y, { steps: 10 });
    await sleep(300);
    const a = await measure(p);
    check(a.cols >= 60, `dragged to ${a.cols} columns`);
    await p.mouse.move(x - 800, y, { steps: 12 });
    await sleep(300);
    const c = await measure(p);
    check(c.session.r - c.session.l >= 300, `transcript dragged to ${c.session.r - c.session.l}`);
    await p.mouse.up();
    for (const [w, h] of [[1280, 800], [1200, 800], [1000, 800], [1440, 900]]) {
      await p.setViewportSize({ width: w, height: h });
      await sleep(800);
      const m = await measure(p);
      check(m.scroll <= m.vw, `${w} px: scrolls sideways`);
      if (!m.cover) check(m.session.r - m.session.l >= 300, `${w} px: transcript ${m.session.r - m.session.l}`);
    }
    await ctx.close();
  },
  /** Widths stored earlier can't break it. */
  async stored() {
    for (const [k, v, w] of [["panel", "3000", 1280], ["panel", "100", 1280], ["panel", "abc", 1280], ["sidebar", "900", 1280], ["sidebar", "480", 1215], ["sidebar", "100", 1280]]) {
      const { ctx, p } = await open({ viewport: { width: w, height: 800 } }, `localStorage.setItem("tether.width.${k}", ${JSON.stringify(v)})`);
      const m = await measure(p);
      const at = `${k} ${v} at ${w}`;
      check(m.scroll <= m.vw, `${at}: scrolls sideways`);
      if (!m.cover) {
        check(m.cols >= 60, `${at}: ${m.cols} columns`);
        check(m.session.r - m.session.l >= 300, `${at}: transcript`);
        check(m.panel.r <= m.vw, `${at}: panel off screen`);
      }
      await ctx.close();
    }
  },
  /** Tucked behind the chat, then room comes: beside again, unhidden. */
  async hidden() {
    const { ctx, p } = await open({ viewport: { width: 1000, height: 800 } });
    await panelButton(p, "Chat").click();
    await sleep(400);
    await p.setViewportSize({ width: 1280, height: 800 });
    await sleep(900);
    const m = await measure(p);
    check(!m.hidden && !m.ret, "still tucked away with room beside the chat");
    await p.setViewportSize({ width: 1280, height: 480 });
    await sleep(900);
    check((await measure(p)).cover, "a window under 500 px high isn't covered");
    await panelButton(p, "Close terminal panel").click();
    await sleep(300);
    await p.setViewportSize({ width: 1000, height: 800 });
    await sleep(600);
    check(!(await measure(p)).panel, "a closed panel came back");
    await ctx.close();
  },
  /** The Back question's buttons stay on screen. */
  async ask() {
    for (const [w, h] of [[1280, 800], [1000, 800], [844, 390], [375, 812]]) {
      const { ctx, p } = await open(w < 900 ? phone(w, h) : { viewport: { width: w, height: h } });
      await panelButton(p, "Back to Tether").click();
      await sleep(300);
      const off = await p.locator(".t-term-panel .t-term-ask button").evaluateAll((l) => l.filter((b) => b.getBoundingClientRect().right > innerWidth || b.getBoundingClientRect().bottom > innerHeight).length);
      check(!off, `${w} px: a button of the question off screen`);
      await panelButton(p, "Stay").click();
      await ctx.close();
    }
  },
  /** One line of placeholder, whole, at the narrowest usual transcript. */
  async placeholder() {
    const { ctx, p } = await open({ viewport: { width: 1280, height: 800 } });
    await p.locator("textarea.t-input[aria-label=Message]").waitFor();
    const g = await p.locator("textarea.t-input[aria-label=Message]").evaluate((t) => {
      const c = getComputedStyle(t);
      const ctx2 = document.createElement("canvas").getContext("2d");
      ctx2.font = `${c.fontWeight} ${c.fontSize} ${c.fontFamily}`;
      return { text: t.placeholder, needs: ctx2.measureText(t.placeholder).width, has: t.clientWidth - parseFloat(c.paddingLeft) - parseFloat(c.paddingRight) };
    });
    console.log("placeholder", JSON.stringify(g));
    check(g.needs <= g.has, `the placeholder takes ${g.needs} px of ${g.has}`);
    await p.screenshot({ path: `${SHOTS}/placeholder-1280.png` });
    await ctx.close();
  },
};

try {
  const only = process.argv.slice(2);
  for (const name of only.length ? only : Object.keys(STEPS)) {
    console.log(`== ${name}`);
    current = await newTui();
    await STEPS[name]();
    await rpc("endTerminal", { sessionId: current });
  }
} catch (e) {
  bad++;
  console.log("FAILED", e?.stack ?? e);
}
for (const id of sessions) await rpc("endTerminal", { sessionId: id }).catch(() => {});
console.log(`layout problems: ${bad}`);
await browser.close();
process.exit(bad ? 1 : 0);
