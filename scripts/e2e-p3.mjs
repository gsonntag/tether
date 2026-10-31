// P3 end-to-end (terminal mode) against a local dev stack and REAL Claude (Haiku), desktop and phone:
//   PLAYWRIGHT=/path/to/playwright/index.mjs node scripts/e2e-p3.mjs [step…]
// Needs a server, a dev runner (with TETHER_TMUX_SOCKET) and vite (docs/acceptance/P3.md Setup).
// Environment:
//   BASE            the web app (default http://127.0.0.1:5182)
//   RUNNER          the dev runner's id (default tether-dev-p3)
//   SCRATCH         a scratch project folder Claude already trusts (default ~/.local/share/tether-dev-p3/projects/scratch)
//   TMUX_SOCKET     the dev runner's tmux socket (default tether-dev-p3)
//   RESTART_RUNNER  a command that restarts the dev runner (for `restart`)
//   HTTP_PORT       a free port for the shell's dev server (default 8899)
//   SHOTS           where screenshots go
// Steps (in order; later ones use the session `new` makes):
//   new keep midturn model phone queue back restart needsyou clear shell exit fresh
// While Claude's TUI drives, Tether doesn't follow its turns (SPEC §8): one state, "Driving in the
// terminal", and Needs you from its hooks; the composer queues for Back to Tether, which asks first.
// Each real turn is small (Haiku).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const BASE = process.env.BASE ?? "http://127.0.0.1:5182";
const RUNNER = process.env.RUNNER ?? "tether-dev-p3";
const SOCKET = process.env.TMUX_SOCKET ?? "tether-dev-p3";
const SHOTS = process.env.SHOTS ?? "/tmp/tether-e2e-p3";
const SCRATCH = process.env.SCRATCH ?? `${process.env.HOME}/.local/share/tether-dev-p3/projects/scratch`;
const RESTART = process.env.RESTART_RUNNER;
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 8899);
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
const errors = [];
const page = async (ctx, url = BASE) => {
  // The dev server on a loaded machine now and then leaves a page blank: try again.
  for (let i = 0; ; i++) {
    const p = await ctx.newPage();
    // Where it happened: the step, and the top of its stack.
    p.on("pageerror", (e) => errors.push(`${current}: ${String(e)}\n    ${(e.stack ?? "").split("\n").slice(1, 6).join("\n    ")}`));
    await p.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    if (i >= 2 || (await p.locator(".t-session, .t-inbox-head").first().waitFor({ timeout: 30_000 }).then(() => true, () => false))) return p;
    await p.close();
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
const composer = (p) => p.locator("textarea.t-input[aria-label=Message]");
const idle = (p, ms = 120_000) => p.locator('button[aria-label="Send"]').waitFor({ timeout: ms });
/** A turn in Tether: it starts (Stop shows), then ends (Send again). */
const turn = async (p, ms = 120_000) => {
  await p.locator('button[aria-label="Stop"]').waitFor({ timeout: 30_000 }).catch(() => {});
  await idle(p, ms);
};
async function send(p, text) {
  await composer(p).fill(text);
  await composer(p).press("Enter");
}
const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const MOD = (name) => `(performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/${name}")) ?? "/src/${name}")`;

let session; // the session URL made in `new`
let current = "start"; // the step running (for page errors)
const sessionId = () => decodeURIComponent(session.split("/").pop());
// The TUI's tmux session keeps the name it started with, also after /clear moves it on.
let tuiOf;
const tuiName = () => tuiOf ?? `t-${sessionId().replace(/[^A-Za-z0-9_-]/g, "-")}`;

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
  fail(`${what}: state is ${JSON.stringify(st && { mode: st.mode, status: st.status, terminal: st.terminal })}`);
};
/** The visible screen of a terminal on the page (by session id or shell id). */
const screen = (p, key) =>
  p.evaluate((key) => {
    const t = globalThis.__tetherTerms?.get(key);
    if (!t) return null;
    const b = t.buffer.active;
    const out = [];
    for (let i = 0; i < t.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
    return { lines: out, cols: t.cols, rows: t.rows };
  }, key);
const waitScreen = async (p, key, re, what, ms = 60_000) => {
  const end = Date.now() + ms;
  let s;
  while (Date.now() < end) {
    s = await screen(p, key);
    if (s && re.test(s.lines.join("\n"))) return s;
    await sleep(250);
  }
  fail(`${what}: the terminal shows:\n${s?.lines.filter((l) => l.trim()).join("\n") ?? "(no terminal)"}`);
};
const tmux = (...args) => spawnSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8" });
const capture = (name) => tmux("capture-pane", "-p", "-t", `=${name}:`).stdout.replace(/\n+$/, "").split("\n");
/** The pane's whole history as tmux has it (scrollback and screen). */
const waitHistory = async (name, re, what, ms = 60_000) => {
  const end = Date.now() + ms;
  let h = "";
  while (Date.now() < end) {
    h = tmux("capture-pane", "-p", "-J", "-S", "-", "-t", `=${name}:`).stdout;
    if (re.test(h)) return;
    await sleep(500);
  }
  fail(`${what}: tmux's history of ${name} doesn't match ${re}; it ends:\n${h.trimEnd().split("\n").slice(-15).join("\n")}`);
};
const windowSize = (name) => tmux("display", "-p", "-t", `=${name}:`, "#{window_width}x#{window_height}").stdout.trim();
/**
 * Each screen line equals tmux's own view of the pane, within the window's width (a terminal bigger
 * than the window shows it at the top left, with tmux's border beside it): nothing garbled.
 */
const sameAsTmux = async (p, key, name, where) => {
  for (let i = 0; i < 20; i++) {
    const s = await screen(p, key);
    const width = Number(windowSize(name).split("x")[0]);
    const cap = capture(name).map((l) => l.trimEnd());
    const mine = s.lines.slice(0, cap.length).map((l) => [...l].slice(0, width).join("").trimEnd());
    const bad = cap.findIndex((l, j) => l !== mine[j]);
    if (bad < 0) return;
    if (i === 19) fail(`${where}: line ${bad} differs from tmux:\n  tmux: ${JSON.stringify(cap[bad])}\n  page: ${JSON.stringify(mine[bad])}`);
    await sleep(250);
  }
};
/**
 * The agent's own terminal UI (P5b): ❯_ opens the panel on a project shell; the agent's entry in its
 * list ("Claude Code", "Codex") is what drives the agent from its terminal.
 */
const pickTerminal = async (p, tap = false) => {
  const chip = p.locator(".t-chip-term");
  if ((await chip.getAttribute("aria-pressed")) !== "true") await (tap ? chip.tap() : chip.click());
  // The panel opens on a project shell; once it's there (a click on the agent's entry while the
  // shell is still opening is taken back when it opens).
  await p.waitForFunction(() => [...(globalThis.__tetherTerms?.keys() ?? [])].some((k) => k.startsWith("sh-")), null, { timeout: 30_000 }).catch(() => {});
  const entry = p.locator(".t-term-agent");
  await (tap ? entry.tap() : entry.click());
};
const openPanel = async (p) => {
  const chip = p.locator(".t-chip-term");
  void chip;
  await pickTerminal(p);
  await p.locator(".t-term-panel").waitFor();
};
/** Types into the terminal with the keyboard, as a person at the desktop would. */
const typeInTerm = async (p, text, enter = true) => {
  await p.locator(".t-term-box").click();
  await p.keyboard.type(text, { delay: 15 });
  if (enter) await p.keyboard.press("Enter");
};
const restart = async () => {
  if (!RESTART) fail("set RESTART_RUNNER");
  execFileSync("sh", ["-c", RESTART], { stdio: "inherit" });
};
const transcriptText = (p) => p.locator(".t-scroll").innerText();
/** Back to Tether from the panel: it asks first (Tether can't tell whether a turn runs), then closes. */
const backToTether = async (p) => {
  await button(p.locator(".t-term-panel"), "Back to Tether").click();
  const ask = p.locator(".t-term-ask", { hasText: "If it's still working, that turn stops" });
  await ask.waitFor({ timeout: 10_000 });
  const text = await ask.innerText();
  if (!/Close Claude Code in the terminal\?/.test(text) || !/input queue is lost/.test(text)) fail(`the question says: ${text}`);
  await button(ask, "Close and go back").click();
  await waitState(p, (s) => s.mode === "live" && !s.terminal, "live again after Back to Tether", 30_000);
};
/** What the TUI shows, scrollback included (tmux's own view). */
const tuiText = (name) => tmux("capture-pane", "-p", "-J", "-S", "-", "-t", `=${name}:`).stdout;

const steps = {
  async new() {
    const p = await page(desktop);
    await p.getByRole("button", { name: "New session" }).first().click();
    await p.locator("#t-new-path").fill(SCRATCH);
    const runnerSelect = p.locator(".t-form select.t-select", { has: p.locator(`option[value="${RUNNER}"]`) });
    if (await runnerSelect.count()) await runnerSelect.selectOption(RUNNER);
    await p.waitForFunction(() => [...document.querySelectorAll(".t-form select option")].some((o) => o.value === "haiku"), null, { timeout: 30_000 });
    await p.locator(".t-form select.t-select", { has: p.locator('option[value="haiku"]') }).selectOption("haiku");
    await p.locator(".t-form select.t-select", { has: p.locator('option[value="acceptEdits"]') }).selectOption("default");
    await button(p, "Create").click();
    await p.waitForURL(/#\/s\//, { timeout: 60_000 });
    session = p.url();
    await composer(p).waitFor();
    await send(p, "Remember the code word PELICAN. Reply with just OK.");
    await turn(p);
    await p.getByText("OK", { exact: true }).first().waitFor({ timeout: 30_000 });
    ok(`new Haiku session, first turn in Tether: ${sessionId()}`);
    await p.close();
  },

  async keep() {
    // A running turn asks before handing off; Keep working leaves it alone.
    const p = await page(desktop, session);
    await composer(p).waitFor();
    await send(p, "Run the shell command `sleep 6 && echo slept` and then reply with just DONE.");
    await p.locator('button[aria-label="Stop"]').waitFor({ timeout: 30_000 });
    await pickTerminal(p);
    const ask = p.locator(".t-term-ask");
    await ask.waitFor();
    const text = await ask.innerText();
    if (!text.includes("Stop this turn and open the terminal?")) fail(`prompt says: ${text}`);
    if (text.includes("queued")) fail(`prompt mentions queued messages with none queued: ${text}`);
    await button(ask, "Stop and open terminal").waitFor();
    await shot(p, "keep-prompt-desktop");
    await button(ask, "Keep working").click();
    await ask.waitFor({ state: "detached" });
    // The panel stays on its shell (❯_ opened one); nothing was handed over.
    if (await p.locator(".t-term-tab.t-term-agent.driving").count()) fail("Keep working handed the session over");
    // Ask first: Claude asks for the shell command; approve it so the turn finishes in Tether.
    const req = p.locator(".t-req").first();
    if (await req.waitFor({ timeout: 30_000 }).then(() => true, () => false)) await button(req, "Approve").click();
    await idle(p);
    const st = await liveState(p);
    if (st.mode !== "live") fail(`mode is ${st.mode} after Keep working`);
    ok('mid-turn, Terminal asks "Stop this turn and open the terminal?" with Stop and open terminal / Keep working; Keep working lets the turn finish live');
    await p.close();
  },

  async midturn() {
    // Acceptance: open the terminal mid-session (a turn running).
    const p = await page(desktop, session);
    await composer(p).waitFor();
    // A turn that is surely still running when Terminal is clicked: a 30 s command (asked first).
    await send(p, "Run the shell command `sleep 30 && echo slept` with Bash, then reply with just DONE.");
    await p.locator('button[aria-label="Stop"]').waitFor({ timeout: 30_000 });
    await pickTerminal(p);
    const ask = p.locator(".t-term-ask");
    await button(ask, "Stop and open terminal").click();
    await waitState(p, (s) => s.mode === "terminal" && s.terminal?.kind === "handoff", "mode terminal after Stop and open terminal");
    // The panel shows the TUI at its prompt. Its banner and the code word may have scrolled off the
    // screen (a session reused with SESSION has a long history): they are looked for in tmux's.
    await waitScreen(p, sessionId(), /❯/, "the TUI in the panel");
    await waitHistory(tuiName(), /Claude Code v\d/, "the TUI's banner");
    await waitHistory(tuiName(), /PELICAN/, "the TUI resumed the same conversation");
    await p.locator(".t-term-banner", { hasText: "Driving in the terminal" }).waitFor();
    if (!(await composer(p).getAttribute("placeholder")).includes("Waits for Back to Tether")) fail("the composer doesn't say its messages wait for Back to Tether");
    await shot(p, "midturn-desktop");
    await noOverflow(p, "desktop with the terminal");
    const argv = tmux("display", "-p", "-t", `=${tuiName()}:`, "#{pane_start_command}").stdout;
    if (!argv.includes(`--resume ${sessionId().split(":")[1]}`) || !argv.includes("--model haiku")) fail(`TUI command: ${argv}`);
    ok("mid-turn: Stop and open terminal stops the turn and resumes the same session in Claude's TUI (claude --resume <id> --model haiku), banner Driving in the terminal");
    await p.close();
  },

  async model() {
    // Acceptance: a Claude-only feature in the TUI (the /model picker), typed at the desktop.
    const p = await page(desktop, session);
    await openPanel(p);
    await waitScreen(p, sessionId(), /❯/, "the TUI prompt");
    await typeInTerm(p, "/model");
    const s = await waitScreen(p, sessionId(), /Haiku 5\.5 ✔|Select model|Enter to set as default/, "the /model picker");
    await shot(p, "model-picker-desktop");
    await p.keyboard.press("Escape");
    await waitScreen(p, sessionId(), /❯[\s\u00a0]*$/m, "the picker closed");
    ok(`the /model picker opens in the TUI from the desktop keyboard (${s.cols}x${s.rows}) and Esc closes it`);
    await p.close();
  },

  async phone() {
    // Acceptance: phone and desktop attach together without a garbled layout.
    const d = await page(desktop, session);
    await openPanel(d);
    await waitScreen(d, sessionId(), /❯/, "desktop TUI");
    const ph = await page(phone, session);
    await ph.locator(".t-term-banner").waitFor({ timeout: 30_000 });
    await ph.locator(".t-term-banner").getByRole("button", { name: "Open Claude Code" }).tap();
    await ph.locator(".t-term-panel").waitFor();
    await waitScreen(ph, sessionId(), /❯/, "phone TUI");
    await ph.locator(".t-keybar").waitFor();
    const keys = await ph.locator(".t-keybar .t-key").allInnerTexts();
    for (const k of ["Esc", "Tab", "⇧Tab", "↑", "↓", "^C", "^D", "⏎"]) if (!keys.includes(k)) fail(`the key bar has no ${k}: ${keys}`);
    await noOverflow(ph, "phone terminal");
    // The phone attached last: the window is the phone's size, and both draw it as tmux does.
    const ps = await screen(ph, sessionId());
    await sleep(800);
    const size = windowSize(tuiName());
    if (size !== `${ps.cols}x${ps.rows}`) fail(`window ${size}, phone ${ps.cols}x${ps.rows}`);
    await sameAsTmux(ph, sessionId(), tuiName(), "phone");
    await sameAsTmux(d, sessionId(), tuiName(), "desktop (window smaller than its terminal)");
    await shot(ph, "phone-terminal");
    await shot(d, "desktop-with-phone");
    // Typing on the desktop takes the window back to the desktop's size (window-size latest).
    await d.locator(".t-term-box").click();
    await d.keyboard.press("Space");
    await d.keyboard.press("Backspace");
    const ds = await screen(d, sessionId());
    for (let i = 0; i < 20 && windowSize(tuiName()) !== `${ds.cols}x${ds.rows}`; i++) await sleep(250);
    if (windowSize(tuiName()) !== `${ds.cols}x${ds.rows}`) fail(`window ${windowSize(tuiName())} after typing on desktop ${ds.cols}x${ds.rows}`);
    await sameAsTmux(d, sessionId(), tuiName(), "desktop after typing there");
    // The key bar types into the TUI: /model, ↓, Esc.
    await ph.locator(".t-term-line input").fill("/model");
    await ph.locator(".t-term-line").getByRole("button", { name: "Send line" }).tap();
    await waitScreen(ph, sessionId(), /Haiku 5\.5 ✔|Enter to set as default/, "the /model picker from the phone");
    await ph.getByRole("button", { name: "Down", exact: true }).tap();
    await ph.getByRole("button", { name: "Escape", exact: true }).tap();
    await waitScreen(ph, sessionId(), /❯[\s\u00a0]*$/m, "the picker closed from the phone key bar");
    await sameAsTmux(ph, sessionId(), tuiName(), "phone after the key bar");
    ok(`phone (${ps.cols}x${ps.rows}) and desktop (${ds.cols}x${ds.rows}) attached at once; each screen matches tmux line for line; the size follows the device typed on; the phone's line and key bar drive the /model picker`);
    await ph.close();
    await d.close();
  },

  async queue() {
    // While the TUI drives, the composer never types into it: a message waits in Tether's queue,
    // held for Back to Tether. No Working/idle either: one state, "Driving in the terminal".
    const p = await page(desktop, session);
    await composer(p).waitFor();
    if (!/Waits for Back to Tether/.test((await composer(p).getAttribute("placeholder")) ?? "")) fail("the composer doesn't say it waits for Back to Tether");
    await send(p, "What is the code word? Reply with just the word, in lowercase.");
    await waitState(p, (s) => s.queue.length === 1 && s.queueHeld && s.queueHeldBy === "terminal", "queued, held for the terminal", 15_000);
    await p.locator(".t-queue", { hasText: "What is the code word?" }).first().waitFor({ timeout: 10_000 });
    await sleep(2000);
    if (/What is the code word\?/.test(tuiText(tuiName()))) fail("the composer's text reached the TUI");
    const st = await liveState(p);
    if (st.status !== "idle") fail(`status ${st.status} while the TUI drives`);
    await p.locator(".t-term-banner-text", { hasText: /^Driving in the terminal$/ }).waitFor({ timeout: 5_000 });
    ok("the composer's message waits in the queue, held for Back to Tether; nothing reached the TUI; the banner says Driving in the terminal");
    await p.close();
  },


  async back() {
    // Back to Tether asks first, closes the TUI (/exit at its empty prompt), resumes the session from
    // Claude's store; the queued message goes then, and the conversation continues.
    const p = await page(desktop, session);
    await openPanel(p);
    await waitState(p, (s) => s.mode === "terminal", "terminal mode", 30_000);
    await waitScreen(p, sessionId(), /❯/, "the TUI");
    await backToTether(p);
    if (tmux("has-session", "-t", `=${tuiName()}`).status === 0) fail("the TUI's tmux session is still there");
    // The message queued while the TUI drove goes now.
    await p.getByText("pelican", { exact: true }).first().waitFor({ timeout: 90_000 });
    await idle(p);
    if ((await composer(p).getAttribute("placeholder")) !== "Message") fail("the composer still says terminal");
    await send(p, "Which code word did I give you, and what did you answer in lowercase last? Reply in one short line.");
    await turn(p);
    const t = await transcriptText(p);
    const last = t.slice(t.lastIndexOf("Which code word"));
    if (!/PELICAN/i.test(last)) fail(`the reply after Back to Tether doesn't know the code word:\n${last}`);
    if (decodeURIComponent(p.url().split("/").pop()) !== sessionId()) fail("the session id changed");
    if (/^\/exit$/m.test(t) || /See ya!|Bye!|Goodbye!/.test(t)) fail("quitting the TUI left /exit or its goodbye in the transcript");
    await shot(p, "back-desktop");
    ok(`Back to Tether asked first, closed the TUI cleanly (no /exit in the transcript), sent the queued message, and the conversation continues ("${last.split("\n").slice(-1)[0].slice(0, 80)}")`);
    await p.close();
  },


  async restart() {
    // Acceptance: the terminal survives a runner restart.
    const p = await page(desktop, session);
    await openPanel(p);
    await waitState(p, (s) => s.mode === "terminal", "terminal mode again (idle: no prompt)", 30_000);
    await waitScreen(p, sessionId(), /❯/, "the TUI");
    await typeInTerm(p, "survives-restart", false);
    await waitScreen(p, sessionId(), /survives-restart/, "typed text");
    const pid = tmux("display", "-p", "-t", `=${tuiName()}:`, "#{pane_pid}").stdout.trim();
    await restart();
    // The view says it lost the runner, then attaches again and tmux redraws the same screen.
    await p.locator(".t-term-status").waitFor({ timeout: 15_000 });
    await p.locator(".t-term-status").waitFor({ state: "detached", timeout: 60_000 });
    await waitScreen(p, sessionId(), /survives-restart/, "the TUI after the runner restart", 60_000);
    await p.locator(`.t-composer textarea[placeholder*="Back to Tether"]`).waitFor({ timeout: 30_000 });
    const pid2 = tmux("display", "-p", "-t", `=${tuiName()}:`, "#{pane_pid}").stdout.trim();
    if (pid !== pid2) fail(`the TUI process changed: ${pid} -> ${pid2}`);
    await waitState(p, (s) => s.mode === "terminal" && s.terminal?.kind === "handoff", "still terminal mode after the restart", 30_000);
    // No status inferred: Driving in the terminal. The TUI still works; the transcript follows it.
    if ((await liveState(p)).status !== "idle") fail("a status was inferred after the restart");
    await p.locator(".t-term-box").click();
    for (let i = 0; i < "survives-restart".length; i++) await p.keyboard.press("Backspace");
    await typeInTerm(p, "Reply with just the word restarted.");
    await p.getByText("restarted", { exact: true }).first().waitFor({ timeout: 60_000 });
    ok("the runner restarted: the same TUI process is still there, the view reattached and redrew, the session stayed Driving in the terminal, and the transcript follows the TUI");
    await p.close();
  },

  async needsyou() {
    // Hooks: Claude asking in the TUI shows as "Needs you" in rows and the banner; it clears once the
    // TUI shows its prompt again (answered there), never on a hook alone.
    rmSync(`${SCRATCH}/needs.txt`, { force: true });
    const p = await page(desktop, session);
    await openPanel(p);
    await waitScreen(p, sessionId(), /❯/, "the TUI");
    await typeInTerm(p, "Create a file needs.txt containing hi, using the Write tool. Do nothing else.");
    await waitState(p, (s) => s.status === "waiting", "waiting (PermissionRequest hook)", 90_000);
    await p.locator(".t-term-banner.waiting", { hasText: "Needs you in the terminal: Claude needs your permission to use Write" }).waitFor();
    await p.locator(".t-row .t-needs").first().waitFor({ timeout: 10_000 });
    const ph = await page(phone, session);
    await ph.locator(".t-term-banner.waiting").waitFor({ timeout: 20_000 });
    await shot(p, "needsyou-desktop");
    await shot(ph, "needsyou-phone");
    // Approve in the terminal itself (the TUI's own dialog), from the phone's key bar.
    await ph.locator(".t-term-banner").getByRole("button", { name: "Open Claude Code" }).tap();
    await waitScreen(ph, sessionId(), /Do you want to|needs\.txt/, "the TUI's permission dialog on the phone");
    await ph.getByRole("button", { name: "Enter", exact: true }).tap();
    await waitState(p, (s) => s.status === "idle" && !s.terminal?.attention, "Needs you cleared after answering in the TUI", 60_000);
    for (let i = 0; i < 40 && !existsSync(`${SCRATCH}/needs.txt`); i++) await sleep(500);
    if (!existsSync(`${SCRATCH}/needs.txt`)) fail("needs.txt wasn't written");
    ok("Claude's permission prompt in the TUI showed as Needs you (row, banner with what for, phone); approved with the phone's ⏎ key, Needs you cleared once the prompt showed again");
    await ph.close();
    await p.close();
  },




  async clear() {
    // /clear in the TUI: Tether follows the new session; the old one points on to it.
    const old = sessionId();
    const p = await page(desktop, session);
    await openPanel(p);
    await waitState(p, (s) => s.mode === "terminal" && s.status === "idle", "terminal mode", 60_000);
    await waitScreen(p, old, /❯/, "the TUI");
    await typeInTerm(p, "/clear");
    await p.waitForFunction((o) => decodeURIComponent(location.hash.split("/").pop()) !== o, old, { timeout: 30_000 });
    const now = decodeURIComponent(p.url().split("/").pop());
    tuiOf = `t-${old.replace(/[^A-Za-z0-9_-]/g, "-")}`;
    await waitState(p, (s) => s.mode === "terminal", "the new session in terminal mode", 30_000);
    await p.locator(".t-term-panel").waitFor();
    await sleep(2000);
    await typeInTerm(p, "Reply with just the word fresh.");
    await p.getByText(/^fresh\.?$/i).first().waitFor({ timeout: 60_000 });
    const q = await page(desktop, session);
    await q.locator(".t-msg.notice", { hasText: "continued in another session after /clear" }).last().waitFor({ timeout: 20_000 });
    const st = await liveState(q);
    if (st.mode !== "stored") fail(`the old session is ${st.mode}`);
    await q.locator(".t-msg.notice .t-link", { hasText: "Open it" }).last().click();
    await q.waitForURL((u) => decodeURIComponent(u.toString().split("/").pop()) === now);
    session = p.url();
    ok(`/clear in the TUI: the view followed to ${now} (typing and hooks work there), the old session is stored with a notice linking to it`);
    await q.close();
    await p.close();
  },

  async shell() {
    // Acceptance: a project shell running a dev server is still there after the panel closes.
    const d = await page(desktop, session);
    await openPanel(d);
    await d.locator(".t-term-panel").getByRole("button", { name: "New shell" }).click();
    // The new shell's tab comes to the front.
    await d.locator(".t-term-tab[aria-selected=true]", { hasText: /^Shell \d+/ }).waitFor({ timeout: 15_000 });
    const shellId = await d.evaluate(() => [...globalThis.__tetherTerms.keys()].find((k) => k.startsWith("sh-")));
    await waitScreen(d, shellId, /\$ *$|# *$|> *$/m, "a shell prompt", 15_000);
    await typeInTerm(d, `python3 -m http.server ${HTTP_PORT} --bind 127.0.0.1`);
    await waitScreen(d, shellId, /Serving HTTP/, "the dev server running");
    await button(d.locator(".t-term-panel"), "Close terminal panel").click();
    await d.locator(".t-term-panel").waitFor({ state: "detached" });
    await sleep(1000);
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/`);
    if (!res.ok) fail(`the dev server answered ${res.status}`);
    // Reopened (on the phone this time): the shell is there, named by what runs in it.
    const ph = await page(phone, session);
    await ph.locator(".t-term-banner").waitFor({ timeout: 30_000 });
    await pickTerminal(ph, true);
    const shellTab = ph.locator(".t-term-tab", { hasText: "python3" });
    await shellTab.waitFor({ timeout: 10_000 });
    await shellTab.tap();
    await waitScreen(ph, shellId, /Serving HTTP/, "the dev server's output on the phone");
    await noOverflow(ph, "phone shell");
    await shot(ph, "shell-phone");
    if (RESTART) {
      await restart();
      await sleep(3000);
      const again = await fetch(`http://127.0.0.1:${HTTP_PORT}/`).catch((e) => e);
      if (!again.ok) fail("the dev server died with the runner");
      await waitScreen(ph, shellId, /Serving HTTP/, "the shell after a runner restart", 60_000);
    }
    // Ctrl-C from the key bar stops it; × closes the shell.
    await ph.getByRole("button", { name: "Control C", exact: true }).tap();
    await waitScreen(ph, shellId, /KeyboardInterrupt|\^C/, "Ctrl-C reached the server");
    await ph.getByRole("button", { name: `Close shell ${shellId.split("-").pop()}`, exact: true }).tap();
    for (let i = 0; i < 20 && tmux("has-session", "-t", `=${shellId}`).status === 0; i++) await sleep(250);
    if (tmux("has-session", "-t", `=${shellId}`).status === 0) fail("the shell is still there after ×");
    ok(`a project shell ran python3 -m http.server; it kept serving after the panel closed${RESTART ? " and after a runner restart" : ""}; the phone reopened it (tab "python3"), ^C stopped it and × closed it`);
    await ph.close();
    await d.close();
  },

  async exit() {
    // The TUI exiting by itself (/exit) leaves the session stored.
    const p = await page(desktop, session);
    await openPanel(p);
    await waitState(p, (s) => s.mode === "terminal", "terminal mode", 30_000);
    await waitScreen(p, sessionId(), /❯/, "the TUI");
    await typeInTerm(p, "/exit");
    await waitState(p, (s) => s.mode === "stored", "stored after /exit", 30_000);
    await p.locator(".t-term-empty", { hasText: "isn't open in the terminal" }).waitFor({ timeout: 10_000 });
    await composer(p).waitFor();
    ok("/exit in the TUI: the session went stored, the panel offers to open it again");
    await p.close();
  },

  async fresh() {
    // A new session started in the terminal (claude --session-id), then back to Tether.
    const p = await page(desktop);
    await p.getByRole("button", { name: "New session" }).first().click();
    await p.locator("#t-new-path").fill(SCRATCH);
    await p.waitForFunction(() => [...document.querySelectorAll(".t-form select option")].some((o) => o.value === "haiku"), null, { timeout: 30_000 });
    await p.locator(".t-form select.t-select", { has: p.locator('option[value="haiku"]') }).selectOption("haiku");
    await p.locator(".t-check input").check();
    await button(p, "Create").click();
    await p.waitForURL(/#\/s\//, { timeout: 60_000 });
    const id = decodeURIComponent(p.url().split("/").pop());
    await waitScreen(p, id, /Claude Code v\d/, "the new session's TUI");
    const argv = tmux("display", "-p", "-t", `=t-${id.replace(/[^A-Za-z0-9_-]/g, "-")}:`, "#{pane_start_command}").stdout;
    if (!argv.includes(`--session-id ${id.split(":")[1]}`)) fail(`TUI command: ${argv}`);
    await waitScreen(p, id, /❯/, "the new session's prompt");
    await typeInTerm(p, "Remember the word OTTER. Reply with just OK.");
    await p.getByText("OK", { exact: true }).first().waitFor({ timeout: 60_000 });
    await sleep(1500);
    await backToTether(p);
    await send(p, "Which word did I ask you to remember? Reply with just the word.");
    await turn(p);
    const t = await transcriptText(p);
    if (!/OTTER/i.test(t.slice(t.lastIndexOf("Which word did I ask")))) fail(`the reply after Back to Tether doesn't know the word:\n${t.slice(-300)}`);
    ok(`a new session started in the terminal under the id Tether picked (--session-id), and after Back to Tether it continues there: ${id}`);
    await p.close();
  },
};

const order = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(steps);
try {
  if (!order.includes("new") && order.some((s) => s !== "fresh")) {
    // Reuse the newest session of this script (SESSION=<url>).
    session = process.env.SESSION ?? fail("run `new` first, or set SESSION to a session URL");
  }
  for (const s of order) {
    current = s;
    if (!steps[s]) fail(`no step ${s}`);
    await steps[s]();
  }
  if (errors.length) fail(`page errors:\n${errors.join("\n")}`);
  console.log(`all passed (${order.join(", ")})${session ? `; session ${session}` : ""}`);
} catch (e) {
  console.error(`FAIL ${e.message}`);
  for (const p of [...desktop.pages(), ...phone.pages()]) await shot(p, `fail-${Date.now()}`).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
