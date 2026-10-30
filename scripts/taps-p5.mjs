// P5 touch targets and phone layout (docs/acceptance/P5.md J1–J3), WebKit at 375 px (iPhone UA, touch):
//   PLAYWRIGHT=… SCRATCH=<a folder Claude Code trusts> [BASE=… RUNNER=… SHOTS=…] node scripts/taps-p5.mjs
// Measures every button, link, menu item and input (wherever it is on the page) on Home, the drawer,
// the New session dialog, a session with a request in the dock, a running session with text typed
// and a file attached (its chip's ×) and the composer's + menu open, the header's menus, a held queue,
// its editor and its folded form, the panel for an edit whose message was cancelled, and the terminal
// banner while Claude's TUI drives. Then: the composer's box width and the header's height at
// 375 px, and the transcript's room with the keyboard up (a 380 px tall view).

const pw = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const { webkit, devices } = pw;
const BASE = process.env.BASE ?? "http://127.0.0.1:5184";
const RUNNER = process.env.RUNNER ?? "tdp5";
const SHOTS = process.env.SHOTS ?? "/tmp/tether-e2e-p5";
const b = await webkit.launch();
const ctx = await b.newContext({ ...devices["iPhone 14 Pro"], viewport: { width: 375, height: 812 } });
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(String(e)));
await p.goto(BASE);
await p.locator(".t-inbox-head").waitFor({ timeout: 60000 });
const MOD = `(performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/connection.ts")) ?? "/src/connection.ts")`;
const rpc = (op, args) =>
  p.evaluate(
    async ([op, args, m, runner]) => {
      const { rpc } = await import(eval(m));
      try {
        return { ok: await rpc(runner, op, args) };
      } catch (e) {
        return { error: e.message };
      }
    },
    [op, args, MOD, RUNNER],
  );
const sweep = (where) =>
  p.evaluate((where) => {
    const out = [];
    const sel = "button, a[href], [role=button], [role=menuitem], [role=menuitemradio], [role=option], input:not([type=hidden]):not([type=file]), select, textarea, summary";
    for (const el of document.querySelectorAll(sel)) {
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || el.closest("[hidden], [aria-hidden=true], [inert]")) continue;
      // Off screen (a long list, a scrolled header): measured where it is; its size doesn't depend on that.
      // A checkbox or radio is tapped through its label.
      const target = el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio") ? el.closest("label") || el : el;
      const r = target.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.height < 44 || (target.tagName !== "TEXTAREA" && target.tagName !== "INPUT" && target.tagName !== "LABEL" && r.width < 44))
        out.push(`${where}: ${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[${el.getAttribute("role")}]` : ""} "${(el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return out;
  }, where);
const small = [];
const checks = [];
const shot = (n) => p.screenshot({ path: `${SHOTS}/taps-${n}.png` });

// Home, the drawer, the New session dialog.
small.push(...(await sweep("home")));
await p.getByRole("button", { name: /navigation|menu/i }).first().tap().catch(() => {});
await p.waitForTimeout(1000);
small.push(...(await sweep("drawer")));
await shot("drawer");
await p.getByRole("button", { name: "New session", exact: true }).first().tap();
await p.locator(".t-form").waitFor();
await p.waitForTimeout(1000);
small.push(...(await sweep("new session dialog")));
await shot("new-session");
await p.keyboard.press("Escape");
await p.goto(BASE);
await p.locator(".t-inbox-head").waitFor();

// A request in the dock.
const a = (await rpc("newSession", { harness: "claude", projectPath: process.env.SCRATCH, model: "haiku", permissionMode: "default" })).ok.sessionId;
await rpc("send", { sessionId: a, text: "Use the Bash tool to run exactly: echo tap > tap.txt   Then reply with one word: done" });
await p.goto(`${BASE}/#/s/${RUNNER}/${encodeURIComponent(a)}`);
await p.locator(".t-req").first().waitFor({ timeout: 90000 });
small.push(...(await sweep("session with a request")));
await shot("request");
const st = (await rpc("subscribe", { sessionId: a })).ok.state;
await rpc("answerRequest", { sessionId: a, requestId: st.requests[0].id, allow: false });
await rpc("unsubscribe", { sessionId: a });

// A running session: text typed, the + menu, the header's menus; widths and heights.
const q = (await rpc("newSession", { harness: "claude", projectPath: process.env.SCRATCH, model: "haiku", permissionMode: "bypassPermissions" })).ok.sessionId;
await rpc("send", { sessionId: q, text: "Use the Bash tool to run exactly: timeout 60 tail -f /dev/null; echo waited   Then reply with exactly one word: DONE" });
await p.goto(`${BASE}/#/s/${RUNNER}/${encodeURIComponent(q)}`);
await p.locator('button[aria-label="Stop"]').waitFor({ timeout: 60000 });
const box = p.locator("textarea.t-input[aria-label=Message]");
// An attachment chip (its ×).
const { writeFileSync, mkdirSync } = await import("node:fs");
mkdirSync(SHOTS, { recursive: true });
writeFileSync(`${SHOTS}/tap-note.txt`, "note\n");
await p.locator('input[type=file][aria-label="Attach files"]').setInputFiles(`${SHOTS}/tap-note.txt`);
await p.locator(".t-files .t-file").waitFor();
await box.fill("typed text while it runs");
small.push(...(await sweep("session running, text typed")));
const boxW = Math.round((await box.boundingBox()).width);
const headH = Math.round((await p.locator(".t-header").boundingBox()).height);
checks.push([`composer box ${boxW} px wide at 375 (≥ 220) while a turn runs with text`, boxW >= 220]);
checks.push([`header ${headH} px tall (≤ 56)`, headH <= 56]);
// The ❯_ Terminal button is pinned at the header's right edge, wholly on screen, at 375 and 393 px.
for (const w of [375, 393]) {
  await p.setViewportSize({ width: w, height: 812 });
  await p.waitForTimeout(300);
  const t = await p.locator(".t-chip-term").boundingBox();
  const inside = !!t && t.x >= 0 && t.x + t.width <= w && t.y >= 0 && t.width >= 44 && t.height >= 44;
  checks.push([`the terminal button wholly on screen at ${w} px (x ${Math.round(t?.x ?? -1)}–${Math.round((t?.x ?? 0) + (t?.width ?? 0))}, ${Math.round(t?.width ?? 0)} × ${Math.round(t?.height ?? 0)})`, inside]);
}
await p.setViewportSize({ width: 375, height: 812 });
await shot("running");
await p.getByRole("button", { name: "More ways to send" }).tap();
await p.getByRole("menuitem").first().waitFor();
// Menus and dialogs open with a short scale-in: measured once it settles.
await p.waitForTimeout(1000);
small.push(...(await sweep("composer + menu")));
await shot("plus-menu");
await p.keyboard.press("Escape");
await p.locator(".t-header .t-chip").first().tap();
await p.waitForTimeout(1000);
small.push(...(await sweep("header menu")));
await p.keyboard.press("Escape");
await p.locator(".t-files .t-file-x").first().tap();
await box.fill("");

// A held queue, its editor, and an edit whose message was cancelled elsewhere.
await rpc("queue", { sessionId: q, text: "Reply with exactly: LATER" });
await rpc("queue", { sessionId: q, text: "Reply with exactly: LATER-2" });
await p.locator(".t-queued").first().waitFor();
await rpc("interrupt", { sessionId: q });
await p.locator(".t-queue", { hasText: "Paused after Stop" }).waitFor({ timeout: 60000 });
small.push(...(await sweep("held queue")));
await shot("queue");
const row = p.locator(".t-queued", { hasText: "LATER-2" });
await row.getByRole("button", { name: "Edit" }).tap();
const save = p.getByRole("button", { name: "Save", exact: true });
const cancel = p.getByRole("button", { name: "Cancel", exact: true });
small.push(...(await sweep("queue edit")));
const [sb, cb] = [await save.boundingBox(), await cancel.boundingBox()];
checks.push(["Save and Cancel on one line", Math.abs(sb.y - cb.y) < 4]);
await shot("queue-edit");
await p.getByRole("textbox", { name: "Edit the queued message" }).fill("Reply with exactly: EDITED");
const later2 = (await rpc("subscribe", { sessionId: q })).ok.state.queue.find((m) => m.text.endsWith("LATER-2"));
await rpc("cancelQueued", { sessionId: q, id: later2.id });
await p.getByText("It was cancelled before your edit was saved.").waitFor({ timeout: 10000 });
small.push(...(await sweep("lost edit")));
await shot("lost-edit");
// The edit survives a reload (this device keeps it until you save, send or discard it).
await p.reload();
await p.getByText("It was cancelled before your edit was saved.").waitFor({ timeout: 30000 });
checks.push(["the lost edit survives a reload", (await p.getByRole("textbox", { name: "Your unsaved edit" }).inputValue()).includes("EDITED")]);
await p.getByRole("button", { name: "Discard", exact: true }).tap();

// The keyboard up: a 380 px tall view still shows the transcript, the queue folded to one line.
await p.setViewportSize({ width: 375, height: 380 });
await p.waitForTimeout(500);
const scroll = await p.locator(".t-scroll").boundingBox();
checks.push([`transcript ${Math.round(scroll?.height ?? 0)} px with the keyboard up (≥ 100)`, (scroll?.height ?? 0) >= 100]);
checks.push(["the queue folds to one line", (await p.locator(".t-queue-fold").count()) === 1]);
small.push(...(await sweep("keyboard up, queue folded")));
await shot("keyboard-up");
await p.setViewportSize({ width: 375, height: 812 });

for (const m of (await rpc("subscribe", { sessionId: q })).ok.state.queue) await rpc("cancelQueued", { sessionId: q, id: m.id });

// The terminal banner (Claude's TUI driving the session; its panel closed).
const term = await rpc("openTerminal", { sessionId: q, cols: 80, rows: 24, stop: true });
if (term.error) checks.push([`the terminal opened (${term.error})`, false]);
else {
  await p.locator(".t-term-banner").waitFor({ timeout: 60000 });
  await p.waitForTimeout(500);
  small.push(...(await sweep("terminal banner")));
  await shot("terminal-banner");
  await rpc("closeTerminal", { attachId: term.ok.attachId });
  await rpc("endTerminal", { sessionId: q });
  await p.locator(".t-term-banner").waitFor({ state: "detached", timeout: 60000 }).catch(() => {});
}
await rpc("unsubscribe", { sessionId: q });
await b.close();
for (const [what, ok] of checks) console.log(`${ok ? "ok " : "FAIL"} ${what}`);
if (errors.length) console.log(`page errors:\n${errors.join("\n")}`);
console.log(small.length ? `FAIL under 44 px:\n${small.join("\n")}` : "ok  every button, link, menu item and input at 375 px is at least 44 × 44");
process.exit(small.length || errors.length || checks.some(([, ok]) => !ok) ? 1 : 0);
