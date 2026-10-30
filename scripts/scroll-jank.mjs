// Scroll jank and cost on a phone, measured: flings over the transcript in WebKit (iPhone 14 Pro)
// and Chromium (Pixel 7), against the fake runner's sessions.
//   BASE=http://127.0.0.1:5188 RUNNER=scrollfake node scripts/scroll-jank.mjs [webkit|chromium|desktop|huge-webkit|huge-chromium]…
// Needs a dev server, `bun scripts/fake-runner.ts <RUNNER>` (HUGE=1500 for the huge-* runs) and the
// web app, preferably a production build (`vite build && vite preview`) for the huge-* numbers.
//
// What it counts, per fling:
//   writes   scrollTop/scrollTo writes on the transcript by the page while the fling runs. iOS
//            Safari ends a momentum scroll on any such write ("it stops scrolling").
//   shifts   frames where the content moved under the viewport by more than 1 px without the
//            reader's input or a write of ours ("jittery").
//   travel   how far the content moved on screen.
//   killed   (WebKit) the fling was cut short by a write, as iOS would. Linux WebKit has no touch
//            scrolling, so the fling is wheel steps with a decaying speed: a finger's drag (touch
//            events sent to the row under it, down for the drag), then momentum with the finger
//            lifted; the driver stops the momentum at the first write, like iOS does.
// Chromium flings are real touch input (CDP touch events, released mid-swipe), CPU slowed 4x.
// huge-*: page 3000 messages in from the top; memory, DOM size, time per page, frames, Send to Stop.

import { execSync } from "node:child_process";

const { webkit, chromium, devices } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const BASE = process.env.BASE ?? "http://127.0.0.1:5188";
const RUNNER = process.env.RUNNER ?? "scrollfake";
const SESSION = process.env.SESSION ?? "claude:scroll-1";
const OLDER = process.env.OLDER ?? "claude:long-1";

const instrument = () => {
  const s = (window.__scroll = { writes: [], phase: "", frames: [], sampling: false });
  const isT = (el) => el?.classList?.contains("t-scroll");
  const d = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get: d.get,
    set(v) {
      if (isT(this) && s.phase) s.writes.push({ t: performance.now(), from: d.get.call(this), to: v, phase: s.phase });
      d.set.call(this, v);
    },
  });
  for (const name of ["scrollTo", "scrollBy", "scrollIntoView"]) {
    const f = Element.prototype[name];
    Element.prototype[name] = function (...a) {
      if ((isT(this) || isT(this.closest?.(".t-scroll"))) && s.phase) s.writes.push({ t: performance.now(), call: name, phase: s.phase });
      return f.apply(this, a);
    };
  }
  // Every frame: follow the row at the middle of the viewport. Its move on screen should be exactly
  // the scroll's; any difference is content shifting under the reader.
  let prev;
  const tick = (t) => {
    const el = document.querySelector(".t-scroll");
    if (s.sampling && el) {
      const r = el.getBoundingClientRect();
      const st = el.scrollTop;
      let shift = 0;
      let move = 0;
      // a frame with a write of ours: the move is the write's (counted as a write, not a shift)
      const wrote = prev && s.writes.length !== prev.w;
      if (prev) {
        const row = document.querySelector(`.t-scroll [data-id="${CSS.escape(prev.id)}"]`);
        if (row) {
          const top = row.getBoundingClientRect().top;
          move = top - prev.top;
          shift = wrote ? 0 : move + (st - prev.st);
        }
      }
      s.frames.push({ t, dt: prev ? t - prev.t : 0, shift, move, st, phase: s.phase });
      const mid = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("[data-id]");
      prev = mid ? { id: mid.dataset.id, top: mid.getBoundingClientRect().top, st, t, w: s.writes.length } : undefined;
    } else prev = undefined;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const urlFor = (session) => `${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(session)}`;

async function open(ctx, session = SESSION, hook = (p) => {}) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log("pageerror", String(e)));
  hook(p);
  await p.goto(urlFor(session));
  await p.locator(".t-scroll [data-id]").first().waitFor({ timeout: 30_000 });
  await p.waitForTimeout(1500);
  return p;
}

const geom = (p) =>
  p.evaluate(() => {
    const el = document.querySelector(".t-scroll");
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom, st: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight };
  });

async function settle(p, max = 5000) {
  let last = -1;
  let same = 0;
  for (let t = 0; t < max; t += 50) {
    const st = await p.evaluate(() => document.querySelector(".t-scroll").scrollTop);
    same = Math.abs(st - last) < 0.5 ? same + 50 : 0;
    if (same >= 400) return;
    last = st;
    await p.waitForTimeout(50);
  }
}

const begin = (p, phase) => p.evaluate((ph) => ((window.__scroll.phase = ph), (window.__scroll.sampling = true), (window.__scroll.mark = window.__scroll.writes.length), (window.__scroll.fmark = window.__scroll.frames.length)), phase);
const writesSince = (p) => p.evaluate(() => window.__scroll.writes.length - window.__scroll.mark);
async function end(p) {
  return p.evaluate(() => {
    const s = window.__scroll;
    const writes = s.writes.slice(s.mark);
    const frames = s.frames.slice(s.fmark);
    s.phase = "";
    s.sampling = false;
    const shifts = frames.filter((f) => Math.abs(f.shift) > 1);
    const el = document.querySelector(".t-scroll");
    return {
      writes: writes.length,
      shifts: shifts.length,
      shiftPx: Math.round(shifts.reduce((a, f) => a + Math.abs(f.shift), 0)),
      travel: Math.round(frames.reduce((a, f) => a + f.move, 0)),
      longFrames: frames.filter((f) => f.dt > 50).length,
      fromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
    };
  });
}

/** WebKit: a finger's drag then momentum, as wheel steps; a write during momentum ends it (iOS). */
async function wkFling(p, up, v0 = 120, decay = 0.94) {
  const g = await geom(p);
  await p.mouse.move(g.x, g.y);
  const sign = up ? -1 : 1;
  // The finger: touch events for the page's own handlers (they don't scroll in Linux WebKit), down
  // for the drag, which scrolls by wheel steps meanwhile, and lifted before the momentum. They go
  // to the row under the finger, as on a phone.
  const touch = (type, cy) =>
    p.evaluate(
      ({ type, x, cy }) => {
        const el = document.querySelector(".t-scroll");
        const target = (window.__touchTarget = type === "touchstart" ? document.elementFromPoint(x, cy) ?? el : window.__touchTarget ?? el);
        // WebKit has no Touch constructor: plain events carrying `touches`.
        const touches = type === "touchend" ? [] : [{ identifier: 1, target, clientX: x, clientY: cy }];
        target.dispatchEvent(Object.defineProperty(new Event(type, { bubbles: true }), "touches", { value: touches }));
      },
      { type, x: g.x, cy },
    );
  await touch("touchstart", g.y);
  for (let i = 0; i < 6; i++) {
    await touch("touchmove", g.y + (up ? 1 : -1) * (i + 1) * 20);
    await p.mouse.wheel(0, sign * v0);
    await p.waitForTimeout(16);
  }
  await touch("touchend", g.y);
  const before = await writesSince(p);
  let v = v0;
  let killed = false;
  while (v > 4) {
    if ((await writesSince(p)) > before) {
      killed = true;
      break;
    }
    await p.mouse.wheel(0, sign * v);
    await p.waitForTimeout(16);
    v *= decay;
  }
  return killed;
}

/** Chromium: a real touch fling: a quick finger swipe, released while moving. */
async function crFling(p, cdp, up) {
  const g = await geom(p);
  const x = Math.round(g.x);
  // start inside the transcript (it can be short with the keyboard open), near the edge the finger leaves
  let y = Math.round(up ? g.top + 10 : g.bottom - 10);
  const step = up ? 40 : -40;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 0; i < 8; i++) {
    y += step;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    await p.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  return false;
}

async function fling(p, eng, up, label) {
  await begin(p, label);
  const killed = eng.webkit ? await wkFling(p, up) : await crFling(p, eng.cdp, up);
  await settle(p);
  return { label, ...(await end(p)), ...(eng.webkit ? { killed } : {}) };
}

/** The top of the history is on screen: no "Earlier messages" row, scrolled to the top. */
const atTop = (p) => p.evaluate(() => !document.querySelector(".t-track > .t-paging:first-child") && document.querySelector(".t-scroll").scrollTop < 2);
/** The first message on screen ("Question 12: …" in long-1). */
const firstSeen = (p) => p.evaluate(() => document.querySelector(".t-scroll [data-id]")?.textContent?.slice(0, 14));

async function cases(ctx, eng, print) {
  const out = { push: print };
  const mk = async (session) => {
    const p = await open(ctx, session);
    if (!eng.webkit) {
      eng.cdp = await ctx.newCDPSession(p);
      await eng.cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    }
    return p;
  };

  // 1. Up and down within loaded history.
  let p = await mk();
  for (let i = 0; i < 3; i++) out.push(await fling(p, eng, true, `updown: up ${i + 1}`));
  for (let i = 0; i < 3; i++) out.push(await fling(p, eng, false, `updown: down ${i + 1}`));
  await p.close();

  // 2. Into older history: fling up until the very first message is on screen (300 short
  // messages, so both engines' flings get there).
  p = await mk(OLDER);
  const agg = { label: "older: flings to the top", flings: 0, writes: 0, shifts: 0, shiftPx: 0, killed: 0, longFrames: 0, travel: 0 };
  for (let i = 0; i < 80; i++) {
    const r = await fling(p, eng, true, "older");
    agg.flings++;
    agg.writes += r.writes;
    agg.shifts += r.shifts;
    agg.shiftPx += r.shiftPx;
    agg.longFrames += r.longFrames;
    agg.travel += r.travel;
    if (r.killed) agg.killed++;
    if (await atTop(p)) break;
  }
  agg.firstSeen = await firstSeen(p);
  agg.reachedTop = await atTop(p);
  out.push(agg);
  await p.close();

  // 3. While a reply streams.
  p = await mk();
  await p.locator("textarea.t-input").fill("long reply for the scroll check");
  await p.locator('button[aria-label="Send"]').click(); // Enter is a new line on a touch screen
  await p.locator('button[aria-label="Stop"]').first().waitFor({ timeout: 10_000 });
  await p.waitForTimeout(1500);
  // How busy the page is while following a stream (Chromium only: CDP).
  if (!eng.webkit) {
    await eng.cdp.send("Performance.enable");
    const busy = async () => Object.fromEntries((await eng.cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    const a = await busy();
    await p.waitForTimeout(4000);
    const b = await busy();
    out.push({ label: "streaming: main thread busy at the bottom", busy: `${Math.round(((b.TaskDuration - a.TaskDuration) / (b.Timestamp - a.Timestamp)) * 100)}%`, layouts: b.LayoutCount - a.LayoutCount, layoutMs: Math.round((b.LayoutDuration - a.LayoutDuration) * 1000), scriptMs: Math.round((b.ScriptDuration - a.ScriptDuration) * 1000) });
  }
  out.push(await fling(p, eng, true, "streaming: up 1"));
  out.push(await fling(p, eng, true, "streaming: up 2"));
  out.push(await fling(p, eng, false, "streaming: down 1"));
  out.push(await fling(p, eng, true, "streaming: up 3"));
  await p.locator('button[aria-label="Send"]').waitFor({ timeout: 60_000 });
  await p.close();

  // 3b. At the bottom, a message long enough to wrap: the composer grows, the view stays following.
  p = await mk();
  await p.locator("textarea.t-input").fill(Array.from({ length: 4 }, (_, i) => `line ${i + 1} of a message that wraps on a phone screen`).join("\n"));
  await p.waitForTimeout(600);
  const fbc = await p.evaluate(() => ((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight))(document.querySelector(".t-scroll")));
  out.push({ label: "composer grows at the bottom", fromBottom: fbc, jumpShown: await p.getByRole("button", { name: "Jump to latest" }).isVisible() });
  await p.close();

  // 4. The keyboard open: a short viewport with the composer focused.
  p = await mk();
  const vp = p.viewportSize();
  await p.locator("textarea.t-input").focus();
  await p.setViewportSize({ width: vp.width, height: 380 });
  await p.waitForTimeout(800);
  out.push({ label: "keyboard: geometry", ...(await geom(p)), vv: await p.evaluate(() => [visualViewport.offsetTop, visualViewport.height, innerHeight]) });
  for (let i = 0; i < 2; i++) out.push(await fling(p, eng, true, `keyboard: up ${i + 1}`));
  out.push(await fling(p, eng, false, "keyboard: down 1"));
  await p.close();
}

/** Desktop: following the bottom while a reply streams, wheel up stays put, Jump to latest. */
async function desktop(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(instrument);
  const p = await open(ctx);
  const fb = () => p.evaluate(() => ((el) => el.scrollHeight - el.scrollTop - el.clientHeight)(document.querySelector(".t-scroll")));
  const res = {};
  res.openAtBottom = (await fb()) < 2;
  await p.locator("textarea.t-input").fill("long reply for the desktop check");
  await p.locator("textarea.t-input").press("Enter");
  await p.locator('button[aria-label="Stop"]').first().waitFor({ timeout: 10_000 });
  let worst = 0;
  for (let i = 0; i < 20; i++) {
    await p.waitForTimeout(150);
    worst = Math.max(worst, await fb());
  }
  res.followWhileStreaming = `worst gap ${Math.round(worst)}px`;
  const g = await geom(p);
  await p.mouse.move(g.x, g.y);
  await p.mouse.wheel(0, -400);
  await p.waitForTimeout(300);
  const st0 = await p.evaluate(() => document.querySelector(".t-scroll").scrollTop);
  await p.waitForTimeout(2000);
  const st1 = await p.evaluate(() => document.querySelector(".t-scroll").scrollTop);
  res.wheelUpStays = Math.abs(st1 - st0) < 2 && (await fb()) > 100;
  res.jumpShown = await p.getByRole("button", { name: "Jump to latest" }).isVisible();
  await p.getByRole("button", { name: "Jump to latest" }).click();
  worst = 0;
  await p.waitForTimeout(200);
  for (let i = 0; i < 10; i++) {
    await p.waitForTimeout(150);
    worst = Math.max(worst, await fb());
  }
  res.followAfterJump = `worst gap ${Math.round(worst)}px`;
  await p.locator('button[aria-label="Send"]').waitFor({ timeout: 60_000 });
  await p.waitForTimeout(500);
  res.endAtBottom = (await fb()) < 2;
  await ctx.close();
  return res;
}

/** Resident memory of the processes under `root` (the largest: the page's web or renderer process). */
function rss(root) {
  try {
    const rows = execSync("ps -eo pid,ppid,rss,comm").toString().split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((a) => a.length >= 4);
    const kids = new Set([String(root)]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [pid, ppid] of rows) if (kids.has(ppid) && !kids.has(pid)) (kids.add(pid), (grew = true));
    }
    return Math.round(Math.max(...rows.filter(([pid]) => kids.has(pid) && pid !== String(root)).map(([, , r]) => +r)) / 1024);
  } catch {
    return -1;
  }
}

/**
 * The huge session (fake runner with HUGE=1500: 3000 messages): page all of it in from the top,
 * timing each page, and measure memory, DOM size, frames while scrolling and streaming, and the
 * time from tapping Send to the Stop button, after 20 pages and after all of them.
 */
async function huge(browser, w) {
  const wk = w === "webkit";
  const ctx = await browser.newContext({ ...devices[wk ? "iPhone 14 Pro" : "Pixel 7"], ...(wk ? { isMobile: false } : {}) });
  let histories = 0;
  const p = await open(ctx, "claude:huge-1", (p) => p.on("websocket", (ws) => ws.on("framesent", (f) => String(f.payload).includes('"history"') && histories++)));
  const pid = process.pid; // the browser runs under this script (via the Playwright driver)
  const log = (o) => console.log(JSON.stringify({ engine: `huge ${w}`, ...o }));
  const dom = () => p.evaluate(() => document.getElementsByTagName("*").length);
  const cdp = wk ? undefined : await ctx.newCDPSession(p);
  /** Chromium: the page's JS heap after a collection */
  const heap = async () => {
    if (!cdp) return {};
    await cdp.send("Performance.enable");
    await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
    const m = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
    return { heapMB: Math.round(m.JSHeapUsedSize / 1e6) };
  };
  const state = async () => ({ loaded: 50 + histories * 50, mounted: await p.evaluate(() => document.querySelectorAll(".t-scroll [data-id]").length), dom: await dom(), rssMB: rss(pid), ...(await heap()) });
  const sendToStop = async (text) => {
    await p.locator("textarea.t-input").fill(text);
    const t = Date.now();
    await p.locator('button[aria-label="Send"]').click();
    await p.locator('button[aria-label="Stop"]').first().waitFor({ timeout: 120_000 });
    const ms = Date.now() - t;
    await p.locator('button[aria-label="Send"]').waitFor({ timeout: 120_000 });
    return ms;
  };
  const frames = (ms) =>
    p.evaluate(async (ms) => {
      const fr = [];
      let last = performance.now();
      let go = true;
      const f = (t) => (fr.push(t - last), (last = t), go && requestAnimationFrame(f));
      requestAnimationFrame(f);
      await new Promise((r) => setTimeout(r, ms));
      go = false;
      fr.sort((a, b) => a - b);
      return { p50: Math.round(fr[fr.length >> 1]), p95: Math.round(fr[Math.floor(fr.length * 0.95)]), max: Math.round(fr.at(-1)), over50: fr.filter((x) => x > 50).length, n: fr.length };
    }, ms);
  log({ at: "open", ...(await state()) });
  const per = [];
  for (let i = 0; i < 80; i++) {
    if (await atTop(p)) break;
    // To the top, as a reader would end a fling there (a wheel notch up first: only the reader's
    // input stops following); then the page arrives (or is mounted again) and the reader's row is
    // put back, moving scrollTop off 0.
    const g = await geom(p);
    await p.mouse.move(g.x, g.y);
    await p.mouse.wheel(0, -100);
    const ms = await p.evaluate(async () => {
      const el = document.querySelector(".t-scroll");
      const t = performance.now();
      el.scrollTop = 0;
      for (let k = 0; k < 400 && el.scrollTop < 50; k++) await new Promise((r) => setTimeout(r, 25));
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      return el.scrollTop < 50 ? -1 : Math.round(performance.now() - t);
    });
    per.push(ms);
    if (i === 19) {
      log({ at: "20 pages up", pageMs: { first: per[0], last10: per.slice(-10) }, ...(await state()) });
      log({ at: "20 pages up", sendToStopMs: await sendToStop("hi") });
    }
  }
  log({ at: "all paged in", pages: per.length, pageMsLast10: per.slice(-10), pageMsMax: Math.max(...per), ...(await state()) });
  // Scrolling down through what's mounted, by wheel.
  const g = await geom(p);
  await p.mouse.move(g.x, g.y);
  const fr = frames(4000);
  for (let i = 0; i < 120; i++) {
    await p.mouse.wheel(0, 150);
    await p.waitForTimeout(16);
  }
  log({ at: "wheel down from the top", frames: await fr });
  log({ at: "top, send", sendToStopMs: await sendToStop("hi"), ...(await state()) });
  // Back to the newest, and a long reply streaming at the bottom.
  await p.getByRole("button", { name: "Jump to latest" }).click();
  await p.waitForTimeout(1500);
  await p.locator("textarea.t-input").fill("long reply at the bottom");
  await p.locator('button[aria-label="Send"]').click();
  await p.locator('button[aria-label="Stop"]').first().waitFor({ timeout: 120_000 });
  await p.waitForTimeout(1000);
  log({ at: "streaming at the bottom", frames: await frames(4000), ...(await state()) });
  await p.locator('button[aria-label="Send"]').waitFor({ timeout: 120_000 });
  await p.waitForTimeout(1500);
  log({ at: "settled at the bottom", ...(await state()) });
  await ctx.close();
}

const which = process.argv.slice(2).length ? process.argv.slice(2) : ["webkit", "chromium", "desktop"];
for (const w of which) {
  const browser = await (w.endsWith("webkit") ? webkit : chromium).launch();
  try {
    if (w.startsWith("huge-")) {
      await huge(browser, w.slice(5));
      continue;
    }
    if (w === "desktop") {
      console.log(JSON.stringify({ engine: "desktop chromium", ...(await desktop(browser)) }));
      continue;
    }
    // Playwright refuses wheel input in mobile WebKit: the iPhone profile minus isMobile (same
    // viewport, pixel ratio, user agent and touch).
    const ctx = await browser.newContext({ ...devices[w === "webkit" ? "iPhone 14 Pro" : "Pixel 7"], ...(w === "webkit" ? { isMobile: false } : {}) });
    await ctx.addInitScript(instrument);
    await cases(ctx, { webkit: w === "webkit" }, (r) => console.log(JSON.stringify({ engine: w, ...r })));
    await ctx.close();
  } finally {
    await browser.close();
  }
}
