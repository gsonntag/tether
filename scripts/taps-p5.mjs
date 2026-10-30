// P5 touch targets (docs/acceptance/P5.md J1): PLAYWRIGHT=… SCRATCH=<a folder Claude Code trusts> [BASE=… RUNNER=…] node scripts/taps-p5.mjs
// WebKit iPhone 14 Pro sweep: every visible button, link and input is at least 44 × 44 px on Home,
// a session (composer, header), the request dock and the queue.
const pw = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const { webkit, devices } = pw;
const BASE = process.env.BASE ?? "http://127.0.0.1:5184";
const RUNNER = process.env.RUNNER ?? "tdp5";
const b = await webkit.launch();
const ctx = await b.newContext({ ...devices["iPhone 14 Pro"] });
const p = await ctx.newPage();
await p.goto(BASE);
await p.locator(".t-inbox-head").waitFor({ timeout: 60000 });
const MOD = `(performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/connection.ts")) ?? "/src/connection.ts")`;
const rpc = (op, args) => p.evaluate(async ([op, args, m, runner]) => { const { rpc } = await import(eval(m)); try { return { ok: await rpc(runner, op, args) }; } catch (e) { return { error: e.message }; } }, [op, args, MOD, RUNNER]);
const sweep = (where) =>
  p.evaluate((where) => {
    const out = [];
    for (const el of document.querySelectorAll("button, a[href], [role=button], input:not([type=hidden]):not([type=file]), select, textarea, summary")) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (!r.width || !r.height || st.visibility === "hidden" || st.display === "none") continue;
      if (r.bottom < 0 || r.top > innerHeight) continue;
      if (r.height < 44 || (el.tagName !== "TEXTAREA" && el.tagName !== "INPUT" && r.width < 44)) out.push(`${where}: ${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return out;
  }, where);
const small = [];
small.push(...(await sweep("home")));
// A request in the dock.
const a = (await rpc("newSession", { harness: "claude", projectPath: process.env.SCRATCH, model: "haiku", permissionMode: "default" })).ok.sessionId;
await rpc("send", { sessionId: a, text: "Use the Bash tool to run exactly: echo tap > tap.txt   Then reply with one word: done" });
await p.goto(`${BASE}/#/s/${RUNNER}/${encodeURIComponent(a)}`);
await p.locator(".t-req").first().waitFor({ timeout: 90000 });
small.push(...(await sweep("session with a request")));
const st = (await rpc("subscribe", { sessionId: a })).ok.state;
await rpc("answerRequest", { sessionId: a, requestId: st.requests[0].id, allow: false });
await rpc("unsubscribe", { sessionId: a });
// A held queue.
const q = (await rpc("newSession", { harness: "claude", projectPath: process.env.SCRATCH, model: "haiku", permissionMode: "bypassPermissions" })).ok.sessionId;
await rpc("send", { sessionId: q, text: "Use the Bash tool to run exactly: timeout 40 tail -f /dev/null; echo waited   Then reply with exactly one word: DONE" });
await p.goto(`${BASE}/#/s/${RUNNER}/${encodeURIComponent(q)}`);
await p.locator('button[aria-label="Stop"]').waitFor({ timeout: 60000 });
await p.locator("textarea.t-input[aria-label=Message]").fill("typed text");
small.push(...(await sweep("session running, text typed")));
await p.locator("textarea.t-input[aria-label=Message]").fill("");
await rpc("queue", { sessionId: q, text: "Reply with exactly: LATER" });
await p.locator(".t-queued").waitFor();
await rpc("interrupt", { sessionId: q });
await p.locator(".t-queue", { hasText: "Paused after Stop" }).waitFor({ timeout: 60000 });
small.push(...(await sweep("held queue")));
await p.locator(".t-queued").getByRole("button", { name: "Edit" }).tap();
small.push(...(await sweep("queue edit")));
await p.screenshot({ path: "/tmp/tether-e2e-p5/taps-sweep.png" });
const qs = (await rpc("subscribe", { sessionId: q })).ok.state.queue;
for (const m of qs) await rpc("cancelQueued", { sessionId: q, id: m.id });
console.log(small.length ? `FAIL under 44 px:\n${small.join("\n")}` : "ok  WebKit iPhone 14 Pro sweep: every button, link and input on Home, a session, the request dock, the queue and its editor is at least 44 × 44 px");
await b.close();
process.exit(small.length ? 1 : 0);
