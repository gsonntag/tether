// Scroll jank on a phone, measured: flings over the transcript in WebKit (iPhone 14 Pro) and
// Chromium (Pixel 7), against the fake runner's "Scroll fixture" session.
//   BASE=http://127.0.0.1:5188 RUNNER=scrollfake node scripts/scroll-jank.mjs [webkit|chromium|desktop]…
// Needs a dev server, `bun scripts/fake-runner.ts <RUNNER>` and vite (README "Local development").
//
// What it counts, per fling:
//   writes   scrollTop/scrollTo writes on the transcript by the page while the fling runs. iOS
//            Safari ends a momentum scroll on any such write ("it stops scrolling").
//   shifts   frames where the content moved under the viewport by more than 1 px without the
//            reader's input or a write of ours (a measured row above changed size, a page arrived): "jittery".
//   travel   how far the content moved on screen.
//   killed   (WebKit) the fling was cut short by a write, as iOS would. Linux WebKit has no touch
//            scrolling, so the fling is wheel steps with a decaying speed (a finger's drag, then
//            momentum), and the driver stops the momentum at the first write, like iOS does.
// Chromium flings are real touch input (CDP touch events, released mid-swipe), CPU slowed 4x.

const { webkit, chromium, devices } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const BASE = process.env.BASE ?? "http://127.0.0.1:5188";
const RUNNER = process.env.RUNNER ?? "scrollfake";
const SESSION = process.env.SESSION ?? "claude:scroll-1";
const URL_ = `${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(SESSION)}`;

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

async function open(ctx) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log("pageerror", String(e)));
  await p.goto(URL_);
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
  // The finger: touch events for the page's own handlers (they don't scroll in Linux WebKit).
  await p.evaluate(({ y, up }) => {
    const el = document.querySelector(".t-scroll");
    // WebKit has no Touch constructor: plain events carrying `touches`.
    const ev = (type, touches) => Object.defineProperty(new Event(type, { bubbles: true }), "touches", { value: touches });
    const t = (cy) => [{ identifier: 1, target: el, clientX: 100, clientY: cy }];
    el.dispatchEvent(ev("touchstart", t(y)));
    for (let i = 1; i <= 6; i++) el.dispatchEvent(ev("touchmove", t(y + (up ? 1 : -1) * i * 20)));
    el.dispatchEvent(ev("touchend", []));
  }, { y: g.y, up });
  for (let i = 0; i < 6; i++) {
    await p.mouse.wheel(0, sign * v0);
    await p.waitForTimeout(16);
  }
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

const loaded = (p) => p.evaluate(() => Object.values(globalThis.__tetherStore.getState().views).map((v) => ({ n: v.window.messages.length, hasOlder: v.window.hasOlder }))[0]);

async function cases(ctx, eng, print) {
  const out = { push: print };
  const mk = async () => {
    const p = await open(ctx);
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

  // 2. Into older history: fling up until the very first message is on screen.
  p = await mk();
  const agg = { label: "older: flings to the top", flings: 0, writes: 0, shifts: 0, shiftPx: 0, killed: 0, longFrames: 0, travel: 0 };
  for (let i = 0; i < 40; i++) {
    const r = await fling(p, eng, true, "older");
    agg.flings++;
    agg.writes += r.writes;
    agg.shifts += r.shifts;
    agg.shiftPx += r.shiftPx;
    agg.longFrames += r.longFrames;
    agg.travel += r.travel;
    if (r.killed) agg.killed++;
    const l = await loaded(p);
    const st = await p.evaluate(() => document.querySelector(".t-scroll").scrollTop);
    if (!l.hasOlder && st < 2) break;
  }
  agg.loaded = (await loaded(p)).n;
  agg.reachedTop = !(await loaded(p)).hasOlder && (await p.evaluate(() => document.querySelector(".t-scroll").scrollTop)) < 2;
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

const which = process.argv.slice(2).length ? process.argv.slice(2) : ["webkit", "chromium", "desktop"];
for (const w of which) {
  const browser = await (w === "webkit" ? webkit : chromium).launch();
  try {
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
