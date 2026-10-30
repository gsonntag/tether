// P4 end-to-end (Codex) against a local dev stack and the REAL shared Codex daemon, desktop (1280)
// and phone (375):
//   PLAYWRIGHT=/path/to/playwright/index.mjs node scripts/e2e-p4.mjs [step…]
// Needs a server, a dev runner (with TETHER_TMUX_SOCKET) and vite (docs/acceptance/P4.md Setup).
// Environment:
//   BASE            the web app (default http://127.0.0.1:5183)
//   RUNNER          the dev runner's id (default tether-dev-p4)
//   SCRATCH         a scratch project folder (default ~/.local/share/tether-dev-p4/projects/scratch)
//   TMUX_SOCKET     the dev runner's tmux socket (default tether-dev-p4)
//   MODEL           the Codex model (default gpt-6-luna: the cheapest the daemon lists); effort Low
//   RESTART_RUNNER  a command that restarts the dev runner (for `restart`)
//   SHOTS           where screenshots go
// Steps (in order; later ones use the session `new` makes):
//   new stream approve deny steer midturn terminal tuiApprove tetherApprove phone subagent restart quit fresh settings
//   storedInject restartMid subOutlive subNewTurn subRestart subKill9 reviewerAuto netRoots bgStop claudeShiftTab stored
// subKill9 needs KILL9_RUNNER (kill -9 the dev runner and start it again).
// claudeShiftTab needs CLAUDE_SCRATCH: a folder Claude already trusts (its trust dialog is never accepted).
// It only ever creates threads in SCRATCH and only drives those. Each real turn is small.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const BASE = process.env.BASE ?? "http://127.0.0.1:5183";
const RUNNER = process.env.RUNNER ?? "tether-dev-p4";
const SOCKET = process.env.TMUX_SOCKET ?? "tether-dev-p4";
const SHOTS = process.env.SHOTS ?? "/tmp/tether-e2e-p4";
const SCRATCH = process.env.SCRATCH ?? `${process.env.HOME}/.local/share/tether-dev-p4/projects/scratch`;
const MODEL = process.env.MODEL ?? "gpt-6-luna";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const MOD = (name) => `(performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/${name}")) ?? "/src/${name}")`;
const scratch = (f) => `${SCRATCH}/${f}`;
const waitFile = async (f, ms = 90_000) => {
  const t = Date.now();
  while (!existsSync(scratch(f))) {
    if (Date.now() - t > ms) fail(`${f} never appeared`);
    await sleep(500);
  }
  return readFileSync(scratch(f), "utf8");
};

let session; // the session URL made in `new`
const sessionId = () => decodeURIComponent(session.split("/").pop());
const tuiName = (id = sessionId()) => `t-${id.replace(/[^A-Za-z0-9_-]/g, "-")}`;

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
  fail(`${what}: state is ${JSON.stringify(st && { mode: st.mode, status: st.status, terminal: st.terminal, requests: st.requests?.length })}`);
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
const capture = (name = tuiName()) => tmux("capture-pane", "-p", "-t", `=${name}:`).stdout;
const waitCapture = async (re, what, ms = 60_000, name = tuiName()) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (re.test(capture(name))) return;
    await sleep(300);
  }
  fail(`${what}: tmux shows:\n${capture(name).split("\n").filter((l) => l.trim()).slice(-15).join("\n")}`);
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
const typeInTerm = async (p, text, enter = true) => {
  // Forced: on a loaded machine the terminal box can keep refitting, and it's never covered.
  await p.locator(".t-term-box").click({ force: true });
  await p.keyboard.type(text, { delay: 15 });
  if (enter) {
    await sleep(200);
    await p.keyboard.press("Enter");
  }
};
const transcriptText = (p) => p.locator(".t-scroll").innerText();
/** The messages as the page renders them (to compare devices). */
const rendered = (p) => p.locator(".t-msg").allInnerTexts();

/** A new Codex session through the dialog: cheap model, Ask first, effort Low before any turn. */
async function newCodexSession(p, { terminal = false } = {}) {
  await p.getByRole("button", { name: "New session" }).first().click();
  const runnerSelect = p.locator(".t-form select.t-select", { has: p.locator(`option[value="${RUNNER}"]`) });
  if (await runnerSelect.count()) await runnerSelect.selectOption(RUNNER);
  await p.getByRole("radio", { name: "Codex" }).click();
  await p.locator("#t-new-path").fill(SCRATCH);
  await p.waitForFunction((m) => [...document.querySelectorAll(".t-form select option")].some((o) => o.value === m), MODEL, { timeout: 30_000 });
  await p.locator(".t-form select.t-select", { has: p.locator(`option[value="${MODEL}"]`) }).selectOption(MODEL);
  await p.locator(".t-form select.t-select", { has: p.locator('option[value="untrusted"]') }).selectOption("untrusted");
  if (terminal) await p.locator(".t-check input").check();
  await shot(p, terminal ? "new-terminal-dialog" : "new-dialog");
  await button(p, "Create").click();
  await p.waitForURL(/#\/s\/.*codex/, { timeout: 60_000 });
  const url = p.url();
  const id = decodeURIComponent(url.split("/").pop());
  // Low effort before anything runs (the folder's Codex config may say otherwise).
  const r = await rpcVia(p, "setEffort", { sessionId: id, effort: "low" });
  if (r.error) fail(`setEffort: ${r.error}`);
  await waitState(p, (s) => s.effort === "low", "effort low");
  return url;
}

const helper = (...args) => execFileSync("bun", ["scripts/codex-e2e-helper.ts", ...args], { cwd: new URL("../runner/", import.meta.url).pathname, encoding: "utf8" }).trim();

/** A Codex session whose subagent outlives the turn that spawned it, on Full access, then shown Read only (undefined: the model waited). */
async function outliveSubagent(p, file) {
  rmSync(scratch(file), { force: true });
  const r = await rpcVia(p, "newSession", { harness: "codex", projectPath: SCRATCH, model: MODEL, permissionMode: "full-access" });
  if (r.error) fail(r.error);
  const id = r.ok.sessionId;
  await rpcVia(p, "setEffort", { sessionId: id, effort: "low" });
  await p.goto(`${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`);
  await composer(p).waitFor({ timeout: 30_000 });
  await send(p, `Spawn exactly one subagent with your agent tool, with the task: run exactly \`sleep 50; echo sub > ${file}\` in the shell, then report done. Do NOT wait for the subagent: as soon as it is spawned, reply with just the word SPAWNED and end your turn.`);
  await waitState(p, (x) => x.status === "running", "the parent's turn", 60_000).catch(() => {});
  await waitState(p, (x) => x.status === "idle", "the parent's turn over", 180_000);
  const kids = (await rpcVia(p, "listSessions", { parentSessionId: id })).ok?.sessions ?? [];
  if (!kids.some((k) => k.status === "running")) return undefined;
  if ((await rpcVia(p, "setPermissionMode", { sessionId: id, mode: "read-only" })).error) fail("setPermissionMode");
  const st = await waitState(p, (x) => x.turnSettings?.who === "subagent" && x.turnSettings?.permissionMode === "full-access", "the subagent's note", 15_000);
  if (!st.turnSettings.looser) fail("not looser");
  if (!/A subagent still runs with Mode Full access/.test(await p.locator(".t-header").innerText())) fail("the note doesn't name the subagent");
  return id;
}

/** Stop this turn stops the subagent: the note goes and its file never comes. */
async function stopsSubagent(p, file) {
  // The note is the subagent's: its button stops just it.
  await button(p.locator(".t-turn-settings"), "Stop the subagent").click();
  await waitState(p, (x) => !x.turnSettings, "the note gone once the subagent stopped", 30_000);
  await sleep(55_000);
  if (existsSync(scratch(file))) fail(`the subagent went on and wrote ${file}`);
}

const steps = {
  async new() {
    for (const f of ["approved.txt", "denied.txt", "tui.txt", "tether.txt", "restart.txt"]) rmSync(scratch(f), { force: true });
    const p = await page(desktop);
    session = await newCodexSession(p);
    const head = await p.locator(".t-header").innerText();
    if (!/GPT-6-Luna|gpt-6-luna/i.test(head) || !/Ask first/.test(head) || !/Low/.test(head)) fail(`header: ${head}`);
    if (!(await composer(p).getAttribute("placeholder")).includes("Message")) fail("no composer");
    await p.getByText("What should Codex do?").waitFor({ timeout: 10_000 });
    await shot(p, "new-desktop");
    ok(`new Codex session (Codex picked in New session; header Model GPT-6-Luna, Effort Low, Mode Ask first): ${sessionId()}`);
    await p.close();
  },

  async stream() {
    // P1 acceptance on Codex: start on desktop, close the tab, open on the phone mid-turn and see it
    // stream; both devices show identical transcripts after the turn.
    const a = await page(desktop, session);
    await composer(a).waitFor();
    await send(a, "Count from 1 to 60, one number per line, nothing else.");
    await a.locator('button[aria-label="Stop"]').waitFor({ timeout: 30_000 });
    await a.close();
    const b = await page(phone, session);
    await waitState(b, (s) => s.status === "running", "running on the phone", 30_000).catch(() => {});
    await b.getByText("60", { exact: false }).first().waitFor({ timeout: 90_000 });
    await idle(b);
    await noOverflow(b, "phone transcript");
    await shot(b, "stream-phone");
    const d = await page(desktop, session);
    await idle(d);
    await sleep(500);
    const [x, y] = [await rendered(d), await rendered(b)];
    if (JSON.stringify(x) !== JSON.stringify(y)) fail(`transcripts differ:\n${x.join("\n---\n")}\n===\n${y.join("\n---\n")}`);
    ok(`started on desktop, tab closed, the phone picked it up and saw it finish; ${x.length} messages identical on both`);
    await b.close();
    await d.close();
  },

  async approve() {
    // P2 acceptance on Codex: a request on both devices; answered on the phone, it clears on desktop;
    // a second answer says Already answered.
    const a = await page(desktop, session);
    const b = await page(phone, session);
    await composer(a).waitFor();
    await send(a, "Use the shell to run exactly: echo approved > approved.txt   Then reply with one word: done.");
    await card(a).waitFor({ timeout: 90_000 });
    await card(b).waitFor({ timeout: 10_000 });
    const title = await card(a).locator(".t-req-title").innerText();
    if (!/Codex wants to run a command/.test(title)) fail(`request title: ${title}`);
    if (!(await card(a).innerText()).includes("echo approved > approved.txt")) fail("the card doesn't show the command");
    const [ra] = (await liveState(a)).requests;
    await shot(a, "approve-desktop");
    await shot(b, "approve-phone");
    await noOverflow(b, "phone with a request");
    await button(card(b), "Approve").tap();
    await card(a).waitFor({ state: "detached", timeout: 10_000 });
    const again = await rpcVia(a, "answerRequest", { sessionId: sessionId(), requestId: ra.id, allow: true });
    if (!/^Already answered/.test(again.error ?? "")) fail(`a second answer said: ${JSON.stringify(again)}`);
    await idle(a);
    if (!/approved/.test(await waitFile("approved.txt"))) fail("approved.txt is wrong");
    ok(`"${title}" showed on desktop and phone; approved on the phone, it cleared on desktop; a second answer: "${again.error}"; Codex ran the command`);
    await a.close();
    await b.close();
  },

  async deny() {
    const p = await page(desktop, session);
    await composer(p).waitFor();
    await send(p, "Use the shell to run exactly: echo no > denied.txt   Then reply in one short sentence.");
    await card(p).waitFor({ timeout: 90_000 });
    await button(card(p), "Deny with reason").click();
    await card(p).getByRole("textbox", { name: "Reason" }).fill("Not this one, just for now: skip it and reply with just the word UNDERSTOOD.");
    await card(p).getByRole("textbox", { name: "Reason" }).press("Enter");
    await card(p).waitFor({ state: "detached", timeout: 10_000 });
    await p.locator(".t-msg", { hasText: "Not this one, just for now" }).first().waitFor({ timeout: 30_000 });
    await idle(p, 120_000);
    if (existsSync(scratch("denied.txt"))) fail("denied.txt exists after the denial");
    if (!/UNDERSTOOD/.test(await transcriptText(p))) fail("Codex didn't read the reason");
    // A plain Deny stops the turn.
    await send(p, "Use the shell to run exactly: echo no > denied.txt");
    await card(p).waitFor({ timeout: 90_000 });
    await button(card(p), "Deny").click();
    await card(p).waitFor({ state: "detached", timeout: 10_000 });
    await idle(p, 60_000);
    if (existsSync(scratch("denied.txt"))) fail("denied.txt exists after Deny");
    ok("Deny with reason: the reason went into the turn (shown as Tether's) and Codex followed it; a plain Deny ended the turn");
    await p.close();
  },

  async steer() {
    // turn/steer: a message into the running turn (the op the P5 composer will use).
    const p = await page(desktop, session);
    await composer(p).waitFor();
    await send(p, "Use the shell to run exactly: sleep 4 && echo slept   Then reply with one short sentence.");
    await card(p).waitFor({ timeout: 90_000 });
    const r = await rpcVia(p, "steer", { sessionId: sessionId(), text: "Also end your reply with the word BANANA." });
    if (r.error) fail(`steer: ${r.error}`);
    await button(card(p), "Approve").click();
    await idle(p);
    const t = await transcriptText(p);
    const last = t.slice(t.lastIndexOf("sleep 4"));
    if (!last.includes("Also end your reply with the word BANANA.")) fail("the steer isn't in the transcript");
    if (!/BANANA\s*$/m.test(last)) fail(`the reply didn't follow the steer:\n${last}`);
    const idleSteer = await rpcVia(p, "steer", { sessionId: sessionId(), text: "x" });
    if (!/Nothing is running/.test(idleSteer.error ?? "")) fail(`steer while idle: ${JSON.stringify(idleSteer)}`);
    ok("steered into the running turn: the message shows in place and the reply follows it; steering an idle session is refused");
    await p.close();
  },

  async midturn() {
    // Codex fixes a turn's settings when it starts (capabilities.settingsApply "nextTurn"): a change
    // made mid-turn shows as counting from the next turn, with the turn's own value, and Stop offered
    // when it tightens.
    const p = await page(desktop, session);
    await composer(p).waitFor();
    if ((await rpcVia(p, "setPermissionMode", { sessionId: sessionId(), mode: "auto" })).error) fail("setPermissionMode auto");
    await send(p, "Run `sleep 12` in the shell, then reply with just: SLEPT");
    await p.locator('button[aria-label="Stop"]').waitFor({ timeout: 30_000 });
    await p.locator(".t-header").getByRole("button", { name: /^Mode:/ }).click();
    await p.getByRole("menuitemradio", { name: /Read only/ }).click();
    const note = p.locator(".t-turn-settings");
    await note.waitFor({ timeout: 15_000 });
    const head = await p.locator(".t-header").innerText();
    if (!/Read only from the next turn/.test(head) || !/This turn still runs with Mode Auto/.test(head)) fail(`header mid-turn: ${head}`);
    await button(note, "Stop this turn").waitFor();
    await shot(p, "midturn-desktop");
    await idle(p, 120_000);
    await note.waitFor({ state: "detached", timeout: 10_000 });
    if (!/Mode\s*Read only/.test(await p.locator(".t-header").innerText())) fail("after the turn the header isn't Read only");
    await rpcVia(p, "setPermissionMode", { sessionId: sessionId(), mode: "untrusted" });
    ok('Read only picked mid-turn shows "Read only from the next turn", "This turn still runs with Mode Auto" and Stop this turn; after the turn it is just Read only');
    await p.close();
  },

  async terminal() {
    // P3 on Codex (shared): the Terminal button opens `codex resume` beside Tether, with no handoff;
    // typing in the TUI and in Tether both work.
    const p = await page(desktop, session);
    await composer(p).waitFor();
    await pickTerminal(p);
    if (await p.locator(".t-term-ask").count()) fail("a shared terminal asked before opening");
    await p.locator(".t-term-panel").waitFor();
    await waitScreen(p, sessionId(), /Ask Codex|›/, "Codex's TUI in the panel", 60_000);
    await waitState(p, (s) => s.mode === "live" && s.terminal?.kind === "shared", "live with a shared terminal");
    const argv = tmux("display", "-p", "-t", `=${tuiName()}:`, "#{pane_start_command}").stdout;
    if (!argv.includes(`resume --remote unix:// ${sessionId().split(":")[1]}`) || !argv.includes(`-m ${MODEL}`)) fail(`TUI command: ${argv}`);
    if (await p.locator(".t-term-banner").count()) fail("a handoff banner shows for a shared terminal");
    if ((await composer(p).getAttribute("placeholder")) !== "Message") fail("the composer isn't Tether's own");
    await shot(p, "terminal-desktop");
    await noOverflow(p, "desktop with the terminal");
    // Typed in the TUI: Tether sees the turn (user message and reply).
    await typeInTerm(p, "Reply with just: FROM-TUI-OK");
    await p.locator(".t-msg", { hasText: "Reply with just: FROM-TUI-OK" }).first().waitFor({ timeout: 30_000 });
    await waitState(p, (s) => s.status === "running", "running (a turn started in the TUI)", 30_000).catch(() => {});
    await idle(p);
    await p.locator(".t-msg.assistant", { hasText: "FROM-TUI-OK" }).first().waitFor({ timeout: 30_000 });
    // Typed in Tether: the TUI shows it.
    await send(p, "Reply with just: FROM-TETHER-OK");
    await idle(p);
    await waitCapture(/FROM-TETHER-OK[\s\S]*FROM-TETHER-OK/, "the TUI shows Tether's message and the reply");
    ok(`Terminal opens Codex's TUI beside Tether (${argv.trim().split(" ").slice(1, 5).join(" ")} …), no prompt, no handoff, mode stays live; a turn typed in the TUI shows in Tether and one sent from Tether shows in the TUI`);
    await p.close();
  },

  async tuiApprove() {
    // An approval answered in the TUI clears in Tether.
    const p = await page(desktop, session);
    await composer(p).waitFor();
    await send(p, "Use the shell to run exactly: echo tui > tui.txt   Then reply with one word: done.");
    await card(p).waitFor({ timeout: 90_000 });
    await waitCapture(/Would you like to run|Yes, proceed/, "the TUI asks too");
    await shot(p, "tui-approve-before");
    tmux("send-keys", "-t", `=${tuiName()}:`, "y");
    await card(p).waitFor({ state: "detached", timeout: 15_000 });
    await idle(p);
    if (!/tui/.test(await waitFile("tui.txt"))) fail("tui.txt is wrong");
    ok("the approval showed in Tether and in the TUI; answered in the TUI (y), it cleared in Tether and the command ran");
    await p.close();
  },

  async tetherApprove() {
    // An approval answered in Tether clears in the TUI.
    const p = await page(desktop, session);
    await composer(p).waitFor();
    await send(p, "Use the shell to run exactly: echo tether > tether.txt   Then reply with one word: done.");
    await card(p).waitFor({ timeout: 90_000 });
    await waitCapture(/Would you like to run/, "the TUI asks too");
    await button(card(p), "Approve").click();
    await card(p).waitFor({ state: "detached", timeout: 10_000 });
    await idle(p);
    const end = Date.now() + 15_000;
    while (/Would you like to run/.test(capture()) && Date.now() < end) await sleep(300);
    if (/Would you like to run/.test(capture())) fail("the TUI still asks after Tether answered");
    if (!/tether/.test(await waitFile("tether.txt"))) fail("tether.txt is wrong");
    ok("answered in Tether: the TUI's prompt went away and the command ran");
    await p.close();
  },

  async phone() {
    // The shared terminal on a phone, beside desktop.
    const d = await page(desktop, session);
    await openPanel(d);
    await waitScreen(d, sessionId(), /›/, "desktop TUI");
    const ph = await page(phone, session);
    await composer(ph).waitFor();
    await pickTerminal(ph, true);
    await ph.locator(".t-term-panel").waitFor();
    await waitScreen(ph, sessionId(), /›/, "phone TUI");
    await ph.locator(".t-keybar").waitFor();
    await noOverflow(ph, "phone terminal");
    await shot(ph, "terminal-phone");
    await button(ph.locator(".t-term-panel"), "Close terminal panel").tap();
    await composer(ph).waitFor();
    await noOverflow(ph, "phone session");
    await shot(ph, "session-phone");
    ok("the shared TUI opens full screen on the phone beside desktop's, with the key bar, and no sideways scroll");
    await ph.close();
    await d.close();
  },

  async subagent() {
    // Subagents are child threads: a child session with its own turns, linked from the parent.
    const p = await page(desktop, session);
    await composer(p).waitFor();
    // Auto: `ls` runs without asking. (In Ask first, Codex 0.165 fails a subagent's approval
    // requests at once: docs/acceptance/P4.md, known gaps.)
    if ((await rpcVia(p, "setPermissionMode", { sessionId: sessionId(), mode: "auto" })).error) fail("setPermissionMode auto");
    await waitState(p, (s) => s.permissionMode === "auto", "mode Auto");
    await send(p, "Spawn exactly one subagent with your agent tool, with the task: list the files in this folder with `ls` and report their names. Wait for it, then reply with its report in one line.");
    const childOf = () =>
      p.evaluate(async (store) => {
        const { useStore } = await import(eval(store));
        const id = decodeURIComponent(location.hash.split("/").pop());
        const v = Object.entries(useStore.getState().views).find(([k]) => k.endsWith(`\u0000${id}`))?.[1];
        return v?.window?.messages.flatMap((m) => m.parts).find((x) => x.type === "tool" && x.childSessionId)?.childSessionId;
      }, MOD("store.ts"));
    let child;
    for (let i = 0; i < 240 && !(child = await childOf()); i++) await sleep(500);
    if (!child) fail("no subagent card linked to a child session");
    // Approvals the subagent asks for (ls is safe, but just in case) are answered here.
    while (!(await p.locator('button[aria-label="Send"]').isVisible())) {
      if (await card(p).isVisible()) await button(card(p), "Approve").click();
      await sleep(500);
    }
    const c = await page(desktop, `${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(child)}`);
    await c.locator(".t-msg", { hasText: "ls" }).first().waitFor({ timeout: 30_000 });
    await shot(c, "subagent-desktop");
    const list = await rpcVia(c, "listSessions", { parentSessionId: sessionId() });
    if (!list.ok?.sessions.some((s) => s.id === child)) fail(`the subagent isn't listed under its parent: ${JSON.stringify(list)}`);
    const steerDone = await rpcVia(c, "steer", { sessionId: child, text: "x" });
    if (!/finished|Nothing is running/.test(steerDone.error ?? "")) fail(`steering a finished subagent: ${JSON.stringify(steerDone)}`);
    await rpcVia(p, "setPermissionMode", { sessionId: sessionId(), mode: "untrusted" });
    ok(`a subagent thread (${child}) is a child session: linked from the parent's card, listed under it, its own transcript shows its ls; a finished one takes no steer`);
    await c.close();
    await p.close();
  },

  async restart() {
    // A runner restart with an approval open: the thread lives on in the daemon, the runner rejoins
    // it, the daemon asks again, and answering it lets the same turn go on.
    if (!RESTART) return console.log("skip restart (set RESTART_RUNNER)");
    const p = await page(desktop, session);
    await composer(p).waitFor();
    await send(p, "Use the shell to run exactly: echo restart > restart.txt   Then reply with one word: done.");
    await card(p).waitFor({ timeout: 90_000 });
    const [before] = (await liveState(p)).requests;
    execFileSync("sh", ["-c", RESTART], { stdio: "inherit" });
    await sleep(3000);
    await card(p).waitFor({ timeout: 60_000 });
    const st = await waitState(p, (s) => s.requests.length === 1 && s.mode === "live", "the request back, live", 60_000);
    if (st.requests[0].id !== before.id) fail("the request came back with another id");
    if (/runner restarted/.test(await transcriptText(p))) fail("a cut-off notice for a turn that went on");
    await button(card(p), "Approve").click();
    await idle(p);
    if (!/restart/.test(await waitFile("restart.txt"))) fail("restart.txt is wrong");
    const t = await transcriptText(p);
    if (/From Tether|approved your request/.test(t.slice(t.lastIndexOf("echo restart")))) fail("the answer went as a message, not to the waiting turn");
    ok("runner restarted mid-approval: rejoined the thread, the same request showed again (same id), approving it let the same turn finish");
    // The TUI outlived the restart and is still shared.
    if (tmux("has-session", "-t", `=${tuiName()}`).status === 0) await waitState(p, (s) => s.terminal?.kind === "shared", "the TUI readopted", 30_000);
    await p.close();
  },

  async quit() {
    const p = await page(desktop, session);
    await openPanel(p);
    await waitScreen(p, sessionId(), /›/, "the TUI");
    await button(p.locator(".t-term-panel"), "Quit Codex").click();
    await waitState(p, (s) => !s.terminal, "no terminal after Quit Codex", 30_000);
    if (tmux("has-session", "-t", `=${tuiName()}`).status === 0) fail("the TUI's tmux session is still there");
    await send(p, "Reply with just: STILL-HERE");
    await idle(p);
    await p.locator(".t-msg.assistant", { hasText: "STILL-HERE" }).first().waitFor({ timeout: 30_000 });
    ok("Quit Codex: the TUI quit and Tether went on driving the same thread");
    await p.close();
  },

  async fresh() {
    // A new session started in the terminal: Tether makes the thread, the TUI joins it at once.
    const p = await page(desktop);
    const url = await newCodexSession(p, { terminal: true });
    const id = decodeURIComponent(url.split("/").pop());
    await p.locator(".t-term-panel").waitFor({ timeout: 30_000 });
    // Ready for input: its prompt line is drawn (Enter before that is lost).
    await waitScreen(p, id, /Ask Codex to do anything/, "the TUI on a new thread", 60_000);
    await sleep(1000);
    // Seen at the prompt before Enter (keys sent while it is still drawing can be lost).
    await typeInTerm(p, "Reply with just: FRESH-OK", false);
    await waitScreen(p, id, /FRESH-OK/, "what was typed at the TUI's prompt", 20_000);
    await sleep(300);
    await p.keyboard.press("Enter");
    await p.locator(".t-msg.assistant", { hasText: "FRESH-OK" }).first().waitFor({ timeout: 90_000 });
    await shot(p, "fresh-desktop");
    ok(`New session → Start in the terminal: the TUI joined a thread Tether made (${id}); its first turn shows in Tether`);
    tmux("kill-session", "-t", `=${tuiName(id)}`);
    await p.close();
  },

  async settings() {
    // A thread made elsewhere keeps its own settings: shown as they are, and not changed by Tether.
    const helper = (...args) => execFileSync("bun", ["scripts/codex-e2e-helper.ts", ...args], { cwd: new URL("../runner/", import.meta.url).pathname, encoding: "utf8" }).trim();
    const id = `codex:${helper("make", SCRATCH, MODEL).split("\n").pop()}`;
    const p = await page(desktop, `${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`);
    await composer(p).waitFor({ timeout: 30_000 });
    const head = await p.locator(".t-header").innerText();
    if (!/GPT-6-Luna/i.test(head) || !/Effort\s*Low/.test(head) || !/Read only/.test(head)) fail(`the header doesn't show the thread's own settings: ${head}`);
    await send(p, "Reply with just: KEPT");
    await idle(p);
    await p.locator(".t-msg.assistant", { hasText: "KEPT" }).first().waitFor({ timeout: 30_000 });
    const after = JSON.parse(helper("settings", id.slice(6)));
    if (after.sandbox !== "read-only" || after.approvalPolicy !== "on-request" || after.effort !== "low" || after.model !== MODEL) fail(`the thread's settings changed: ${JSON.stringify(after)}`);
    const head2 = await p.locator(".t-header").innerText();
    if (!/Read only/.test(head2) || !/Effort\s*Low/.test(head2)) fail(`header after a turn: ${head2}`);
    ok(`a thread made elsewhere (GPT-6-Luna, Low, read-only) shows its own settings before anything is sent, and a turn from Tether leaves them as they were (${JSON.stringify(after)})`);
    await p.close();

    // A change made in Tether while the thread is held by another client (as Codex's TUI holds it):
    // applied after the join and confirmed, so the turn runs with it.
    const id2 = `codex:${helper("make", SCRATCH, MODEL, "workspace-write").split("\n").pop()}`;
    const holder = spawn("bun", ["scripts/codex-e2e-helper.ts", "hold", id2.slice(6), "120000"], { cwd: new URL("../runner/", import.meta.url).pathname, stdio: "ignore" });
    try {
      await sleep(2000);
      const q = await page(desktop, `${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id2)}`);
      await composer(q).waitFor({ timeout: 30_000 });
      if (!/Mode\s*Auto/.test(await q.locator(".t-header").innerText())) fail("the second thread isn't Auto");
      const r = await rpcVia(q, "setPermissionMode", { sessionId: id2, mode: "read-only" });
      if (r.error) fail(r.error);
      await send(q, "Reply with just: TIGHT");
      await idle(q);
      await q.locator(".t-msg.assistant", { hasText: "TIGHT" }).first().waitFor({ timeout: 30_000 });
      const s2 = JSON.parse(helper("settings", id2.slice(6)));
      if (s2.sandbox !== "read-only") fail(`the turn ran with ${JSON.stringify(s2)}, not read-only`);
      if (!/Mode\s*Read only/.test(await q.locator(".t-header").innerText())) fail("the header doesn't say Read only");
      ok(`Read only chosen in Tether while another client held the thread: applied and confirmed before the turn, which ran read-only (${JSON.stringify(s2)})`);
      await q.close();
    } finally {
      holder.kill();
    }
  },

  async storedInject() {
    // A send to a stored session whose thread runs a turn another client started (review 5, M1):
    // refused as busy, with that turn's own settings shown, never slipped into it.
    if (!RESTART) return console.log("skip storedInject (set RESTART_RUNNER)");
    rmSync(scratch("inj.txt"), { force: true });
    const p = await page(desktop);
    const r = await rpcVia(p, "newSession", { harness: "codex", projectPath: SCRATCH, model: MODEL, permissionMode: "full-access" });
    if (r.error) fail(r.error);
    const id = r.ok.sessionId;
    await rpcVia(p, "setEffort", { sessionId: id, effort: "low" });
    await p.goto(`${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`);
    await composer(p).waitFor({ timeout: 30_000 });
    await send(p, "Reply with just: READY");
    await idle(p);
    // Truly over (so the restart leaves it stored, not rejoined): the send below must find the turn.
    await waitState(p, (x) => x.status === "idle", "idle after READY", 60_000);
    await sleep(2000);
    await p.close();
    execFileSync("sh", ["-c", RESTART], { stdio: "inherit" });
    const other = spawn("bun", ["scripts/codex-e2e-helper.ts", "turn", id.slice(6), "Use the shell to run exactly: sleep 30   Then reply with one word: slept."], { cwd: new URL("../runner/", import.meta.url).pathname, stdio: "ignore" });
    try {
      await sleep(12_000);
      const q = await page(desktop, `${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`);
      await composer(q).waitFor({ timeout: 60_000 });
      if ((await rpcVia(q, "setPermissionMode", { sessionId: id, mode: "read-only" })).error) fail("setPermissionMode");
      const sent = await rpcVia(q, "send", { sessionId: id, text: "Also run exactly: echo inj > inj.txt   then reply INJ." });
      // Refused as busy: "still working on a turn started elsewhere" when the send found the turn on
      // joining, plain "still working" when Tether was already on the thread and saw it start.
      if (!/still working/.test(sent.error ?? "")) fail(`the send wasn't refused: ${JSON.stringify(sent)}`);
      console.log(`    (refused: ${sent.error})`);
      const st = await waitState(q, (x) => x.status === "running" && x.turnSettings?.permissionMode === "full-access", "running, with the turn's own mode shown", 30_000);
      if (!st.turnSettings.looser) fail("not marked as running looser");
      const head = await q.locator(".t-header").innerText();
      if (!/Read only from the next turn/.test(head) || !/This turn still runs with Mode Full access/.test(head)) fail(`header: ${head}`);
      await button(q.locator(".t-turn-settings"), "Stop this turn").waitFor();
      await idle(q, 120_000);
      await sleep(1500);
      if (existsSync(scratch("inj.txt"))) fail("inj.txt was written");
      ok("a send to a stored session whose thread runs another client's turn is refused as busy; that turn's Full access shows beside Read only, with Stop; nothing slipped into it");
      await q.close();
    } finally {
      other.kill();
    }
  },

  async restartMid() {
    // A runner restart mid-turn keeps the note (review 5, I1): rebuilt from the turn's turn_context.
    if (!RESTART) return console.log("skip restartMid (set RESTART_RUNNER)");
    const p = await page(desktop);
    const r = await rpcVia(p, "newSession", { harness: "codex", projectPath: SCRATCH, model: MODEL, permissionMode: "full-access" });
    if (r.error) fail(r.error);
    const id = r.ok.sessionId;
    await rpcVia(p, "setEffort", { sessionId: id, effort: "low" });
    await p.goto(`${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`);
    await composer(p).waitFor({ timeout: 30_000 });
    await send(p, "Use the shell to run exactly this one command: sleep 25   Then reply with one word: done.");
    await p.locator(".t-msg", { hasText: "sleep 25" }).first().waitFor({ timeout: 90_000 });
    if ((await rpcVia(p, "setPermissionMode", { sessionId: id, mode: "read-only" })).error) fail("setPermissionMode");
    await waitState(p, (x) => x.turnSettings?.permissionMode === "full-access", "the note before the restart", 15_000);
    await p.close();
    execFileSync("sh", ["-c", RESTART], { stdio: "inherit" });
    const q = await page(desktop, `${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`);
    await composer(q).waitFor({ timeout: 60_000 });
    const st = await waitState(q, (x) => x.status === "running" && x.turnSettings?.permissionMode === "full-access" && x.permissionMode === "read-only", "the note after the restart", 45_000);
    if (!st.turnSettings.looser) fail("not marked looser after the restart");
    await idle(q, 120_000);
    await waitState(q, (x) => !x.turnSettings, "the note gone after the turn", 15_000);
    ok("restarted mid-turn: rejoined, and the turn's own Full access still shows beside Read only until it ends");
    await q.close();
  },

  async claudeShiftTab() {
    // Claude's handoff TUI: a mode picked there (Shift+Tab) shows in Tether at its next hook (review 5,
    // I3); Tether's own settings are refused while it drives; the model says "Set in the terminal".
    const CL = process.env.CLAUDE_SCRATCH;
    if (!CL) return console.log("skip claudeShiftTab (set CLAUDE_SCRATCH to a folder Claude already trusts)");
    const p = await page(desktop);
    const r = await rpcVia(p, "newSession", { harness: "claude", projectPath: CL, model: "haiku", permissionMode: "default", terminal: true });
    if (r.error) fail(r.error);
    const id = r.ok.sessionId;
    await p.goto(`${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`);
    await waitState(p, (s) => s.mode === "terminal", "terminal mode", 60_000);
    const name = tuiName(id);
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      const c = capture(name);
      if (/trust this folder|Yes, I trust/i.test(c)) {
        tmux("kill-session", "-t", `=${name}`);
        fail("Claude asks to trust the folder: use a folder it already trusts (never accepted here)");
      }
      if (/shift\+tab|\? for shortcuts/i.test(c)) break;
      await sleep(500);
    }
    tmux("send-keys", "-t", `=${name}:`, "BTab");
    await waitCapture(/accept edits on/i, "the TUI in accept edits", 15_000, name);
    tmux("send-keys", "-t", `=${name}:`, "-l", "Reply with just: OK");
    await sleep(500);
    tmux("send-keys", "-t", `=${name}:`, "Enter");
    await waitState(p, (s) => s.permissionMode === "acceptEdits", "accept edits from the TUI's hook", 60_000);
    const head = await p.locator(".t-header").innerText();
    if (!/Accept edits/.test(head) || !/Set in the terminal/.test(head)) fail(`header: ${head}`);
    const refused = await rpcVia(p, "setPermissionMode", { sessionId: id, mode: "plan" });
    if (!/terminal is driving/.test(refused.error ?? "")) fail(`not refused: ${JSON.stringify(refused)}`);
    await shot(p, "claude-shifttab");
    ok("Shift+Tab in Claude's TUI shows as Accept edits in Tether (from its hook), the model as Set in the terminal, and Tether's own change is refused while it drives");
    tmux("kill-session", "-t", `=${name}`);
    await p.close();
  },

  async subOutlive() {
    // A subagent that outlives its parent's turn keeps the turn's settings (review 5, I2): the note
    // ("A subagent still runs with …") and Stop stay while it runs, and Stop stops it too.
    const p = await page(desktop);
    const id = await outliveSubagent(p, "sub.txt");
    if (!id) return console.log("skip subOutlive: the model waited for its subagent (nothing outlived the turn)"), await p.close();
    await stopsSubagent(p, "sub.txt");
    ok("a subagent outliving its parent's turn keeps its note and Stop; Stop stopped it before it wrote");
    await p.close();
  },

  async subNewTurn() {
    // A new turn (a queue drain, a ! command's output, a message) while a subagent outlives the
    // last one (review 6, I1): the subagent's own entry stays, whatever the new turn runs with.
    const p = await page(desktop);
    const id = await outliveSubagent(p, "sub2.txt");
    if (!id) return console.log("skip subNewTurn: nothing outlived the turn"), await p.close();
    await send(p, "Reply with just: SECOND");
    await p.locator(".t-msg.assistant", { hasText: "SECOND" }).first().waitFor({ timeout: 90_000 });
    const st = await liveState(p);
    if (st.turnSettings?.who !== "subagent" || st.turnSettings?.permissionMode !== "full-access") fail(`the subagent's note is gone after a new turn: ${JSON.stringify(st.turnSettings)}`);
    await stopsSubagent(p, "sub2.txt");
    ok("a new turn while a subagent outlives the last one: the subagent's Full access note and Stop stay; Stop stopped it");
    await p.close();
  },

  async subKill9() {
    // subRestart with kill -9 on the runner (review 7): nothing gets to save on the way out.
    if (!process.env.KILL9_RUNNER) return console.log("skip subKill9 (set KILL9_RUNNER)");
    return steps.subRestart(process.env.KILL9_RUNNER);
  },

  async netRoots() {
    // A sandbox with network and an extra writable root, set by another client (review 7, M2):
    // Custom, with the note and Stop while a turn runs with it; Auto from Tether turns them off.
    const WR = `${SCRATCH}-wr`;
    mkdirSync(WR, { recursive: true });
    rmSync(`${WR}/wr.txt`, { force: true });
    const p = await page(desktop);
    const r = await rpcVia(p, "newSession", { harness: "codex", projectPath: SCRATCH, model: MODEL, permissionMode: "auto" });
    if (r.error) fail(r.error);
    const id = r.ok.sessionId;
    await rpcVia(p, "setEffort", { sessionId: id, effort: "low" });
    await p.goto(`${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`);
    await composer(p).waitFor({ timeout: 30_000 });
    await send(p, "Reply with just: OK");
    await idle(p);
    helper("set", id.slice(6), JSON.stringify({ sandboxPolicy: { type: "workspaceWrite", writableRoots: [WR], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false } }));
    await waitState(p, (x) => x.permissionMode === "custom", "Custom shown", 15_000);
    const other = spawn("bun", ["scripts/codex-e2e-helper.ts", "turn", id.slice(6), `Use the shell to run exactly: sleep 8; echo wr > ${WR}/wr.txt   Then reply with one word: done.`], { cwd: new URL("../runner/", import.meta.url).pathname, stdio: "ignore" });
    try {
      const st = await waitState(p, (x) => x.turnSettings?.permissionMode === "custom" && x.turnSettings.looser, "the note for a turn running Custom", 45_000);
      void st;
      await button(p.locator(".t-turn-settings"), "Stop this turn").waitFor();
      await idle(p, 120_000);
    } finally {
      other.kill();
    }
    if ((await rpcVia(p, "setPermissionMode", { sessionId: id, mode: "auto" })).error) fail("setPermissionMode auto");
    await waitState(p, (x) => x.permissionMode === "auto", "plain Auto again", 15_000);
    rmSync(WR, { recursive: true, force: true });
    ok("network and an extra writable root set elsewhere show as Custom, with the note and Stop while a turn runs with them; Auto from Tether turns them off");
    await p.close();
  },

  async bgStop() {
    // Stop ends only what its own turn left running (review 7, I1): a dev server from an earlier
    // turn goes on.
    const PORT = Number(process.env.BG_PORT ?? 8798);
    const curl = () => spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "2", `http://127.0.0.1:${PORT}/`], { encoding: "utf8" }).stdout;
    if (curl() !== "000") fail(`port ${PORT} is busy`);
    const p = await page(desktop);
    const r = await rpcVia(p, "newSession", { harness: "codex", projectPath: SCRATCH, model: MODEL, permissionMode: "full-access" });
    if (r.error) fail(r.error);
    const id = r.ok.sessionId;
    await rpcVia(p, "setEffort", { sessionId: id, effort: "low" });
    await p.goto(`${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`);
    await composer(p).waitFor({ timeout: 30_000 });
    try {
      await send(p, `Use your shell tool to run exactly this command: python3 -m http.server ${PORT} --bind 127.0.0.1   It serves forever: do not wait for it to finish and do not stop it. Leave it running in the background, then reply with just: STARTED`);
      await idle(p, 180_000);
      for (let i = 0; i < 20 && curl() !== "200"; i++) await sleep(500);
      if (curl() !== "200") return console.log("skip bgStop: the model didn't leave the server running"), await p.close();
      await send(p, "Use the shell to run exactly: sleep 30   Then reply with one word: done.");
      await waitState(p, (x) => x.status === "running", "the second turn", 30_000);
      await sleep(6000);
      await rpcVia(p, "interrupt", { sessionId: id });
      await waitState(p, (x) => x.status === "idle", "idle after Stop", 30_000);
      await sleep(3000);
      if (curl() !== "200") fail("Stop ended the dev server an earlier turn started");
      ok("Stop on a later turn left the dev server the earlier turn started running");
    } finally {
      const pids = spawnSync("sh", ["-c", `ss -ltnp | grep ':${PORT} ' | grep -o 'pid=[0-9]*' | cut -d= -f2`], { encoding: "utf8" }).stdout.trim();
      for (const x of pids.split("\n").filter(Boolean)) spawnSync("kill", [x]);
      await p.close();
    }
  },

  async nestedStop() {
    // A nested subagent (review 8, M1): Stop reaches it through the main session's driver, whether
    // pressed on it or as the main Stop; nothing it was running goes on.
    const p = await page(desktop);
    const r = await rpcVia(p, "newSession", { harness: "codex", projectPath: SCRATCH, model: MODEL, permissionMode: "full-access" });
    if (r.error) fail(r.error);
    const id = r.ok.sessionId;
    await rpcVia(p, "setEffort", { sessionId: id, effort: "low" });
    await p.goto(`${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`);
    await composer(p).waitFor({ timeout: 30_000 });
    const deepest = async () => {
      const kids = async (x) => (await rpcVia(p, "listSessions", { parentSessionId: x })).ok?.sessions ?? [];
      for (const m of await kids(id)) for (const n of await kids(m.id)) if (n.status === "running") return n.id;
    };
    const waitDeep = async () => {
      for (let i = 0; i < 120; i++) {
        const d = await deepest();
        if (d) return d;
        await sleep(1000);
      }
    };
    const task = (f) => `Spawn one subagent. Its task: spawn your own subagent (a nested one) whose task is to run in the shell exactly: sleep 40; echo nest > ${f}   Then you (the middle subagent) reply done without waiting for it.`;
    const f1 = "nest1.txt";
    const f2 = "nest2.txt";
    rmSync(scratch(f1), { force: true });
    rmSync(scratch(f2), { force: true });
    await send(p, `${task(f1)} You, the main agent, do not wait for your subagent either: as soon as it is spawned reply with just the word SPAWNED and end your turn.`);
    const deep = await waitDeep();
    if (!deep) return console.log("skip nestedStop: the model didn't nest a subagent"), await p.close();
    if ((await rpcVia(p, "interrupt", { sessionId: deep })).error) fail("Stop on a nested subagent");
    await sleep(45_000);
    if (existsSync(scratch(f1))) fail("Stop on the nested subagent did nothing: its command went on");
    await idle(p, 60_000);
    // The main Stop, with the turn still going.
    await send(p, `${task(f2)} You, the main agent, wait for your subagent to finish before you reply.`);
    if (!(await waitDeep())) return console.log("skip nestedStop's main Stop: the model didn't nest a subagent"), await p.close();
    await rpcVia(p, "interrupt", { sessionId: id });
    await sleep(45_000);
    if (existsSync(scratch(f2))) fail("the main Stop didn't reach the nested subagent");
    ok("Stop on a nested subagent stopped it, through the main session's driver, and the main Stop reaches nested subagents too");
    await p.close();
  },

  async bgNote() {
    // A command left in a background terminal keeps its turn's settings (review 8, M2): after
    // tightening, one note and Stop for it, found again after a restart; Stop ends exactly it.
    const PORT = Number(process.env.BG_PORT ?? 8798) + 1;
    const curl = () => spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "2", `http://127.0.0.1:${PORT}/`], { encoding: "utf8" }).stdout;
    if (curl() !== "000") fail(`port ${PORT} is busy`);
    const p = await page(desktop);
    const r = await rpcVia(p, "newSession", { harness: "codex", projectPath: SCRATCH, model: MODEL, permissionMode: "full-access" });
    if (r.error) fail(r.error);
    const id = r.ok.sessionId;
    await rpcVia(p, "setEffort", { sessionId: id, effort: "low" });
    await p.goto(`${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`);
    await composer(p).waitFor({ timeout: 30_000 });
    let q = p;
    try {
      await send(p, `Use your shell tool to run exactly this command: python3 -m http.server ${PORT} --bind 127.0.0.1   It serves forever: do not wait for it to finish and do not stop it. Leave it running in the background, then reply with just: STARTED`);
      await idle(p, 180_000);
      for (let i = 0; i < 20 && curl() !== "200"; i++) await sleep(500);
      if (curl() !== "200") return console.log("skip bgNote: the model didn't leave the server running");
      if (await p.locator(".t-turn-settings").count()) fail("a note while the command runs as shown");
      if ((await rpcVia(p, "setPermissionMode", { sessionId: id, mode: "read-only" })).error) fail("setPermissionMode");
      await waitState(p, (x) => x.turnSettings?.who === "background" && x.turnSettings.permissionMode === "full-access" && x.turnSettings.looser && x.turnSettings.count === 1, "the background command's note", 15_000);
      if (!/A background command still runs with Mode Full access/.test(await p.locator(".t-header").innerText())) fail("the note doesn't speak of the command");
      await shot(p, "bg-note");
      if (RESTART) {
        await p.close();
        execFileSync("sh", ["-c", RESTART], { stdio: "inherit" });
        q = await page(desktop, `${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`);
        await composer(q).waitFor({ timeout: 60_000 });
        await waitState(q, (x) => x.turnSettings?.who === "background" && x.turnSettings.permissionMode === "full-access", "the note after a restart", 45_000);
      }
      if (curl() !== "200") fail("the command ended by itself");
      await button(q.locator(".t-turn-settings"), "Stop the command").click();
      await waitState(q, (x) => !x.turnSettings, "the note gone", 30_000);
      await sleep(1000);
      if (curl() === "200") fail("Stop the command left it running");
      ok("a dev server left from a Full access turn: after tightening, one note and Stop the command (found again after a restart); Stop ended it");
    } finally {
      const pids = spawnSync("sh", ["-c", `ss -ltnp | grep ':${PORT} ' | grep -o 'pid=[0-9]*' | cut -d= -f2`], { encoding: "utf8" }).stdout.trim();
      for (const x of pids.split("\n").filter(Boolean)) spawnSync("kill", [x]);
      await q.close().catch(() => {});
    }
  },

  async tuiPermissions() {
    // The TUI's /permissions sets a built-in permission profile (review 8, I1): shown as the preset,
    // not Custom. Only Read Only and Ask for approval are picked (session settings, nothing saved).
    const p = await page(desktop);
    const r = await rpcVia(p, "newSession", { harness: "codex", projectPath: SCRATCH, model: MODEL, permissionMode: "auto" });
    if (r.error) fail(r.error);
    const id = r.ok.sessionId;
    await rpcVia(p, "setEffort", { sessionId: id, effort: "low" });
    await p.goto(`${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`);
    await composer(p).waitFor({ timeout: 30_000 });
    await send(p, "Reply with just: OK");
    await idle(p);
    await pickTerminal(p);
    await p.locator(".t-term-panel").waitFor();
    await waitScreen(p, id, /Ask Codex/, "Codex's TUI", 60_000);
    const pickIn = async (label) => {
      await typeInTerm(p, "/permissions", false);
      await sleep(600);
      await p.keyboard.press("Enter");
      await waitScreen(p, id, /Update Model Permissions/, "the permissions menu", 15_000);
      for (let i = 0; i < 6; i++) {
        const s = await screen(p, id);
        if (s.lines.some((l) => l.includes(`›`) && l.includes(label))) break;
        await p.keyboard.press("ArrowDown");
        await sleep(250);
      }
      await p.keyboard.press("Enter");
      await sleep(500);
    };
    await pickIn("Read Only");
    await waitState(p, (x) => x.permissionMode === "read-only", "Read only shown (not Custom)", 15_000);
    await pickIn("Ask for approval");
    await waitState(p, (x) => x.permissionMode === "auto", "Auto shown (not Custom)", 15_000);
    ok("/permissions in the TUI: Read Only and Ask for approval show as Read only and Auto, not Custom");
    tmux("kill-session", "-t", `=${tuiName(id)}`);
    await p.close();
  },

  async subRestart(restartWith = RESTART) {
    // A runner restart while a subagent outlives its parent's turn (review 6, I2): rejoined, the
    // subagent found again with its own settings, still running, with the note and Stop.
    if (!restartWith) return console.log("skip subRestart (set RESTART_RUNNER)");
    const p = await page(desktop);
    const id = await outliveSubagent(p, "sub3.txt");
    if (!id) return console.log("skip subRestart: nothing outlived the turn"), await p.close();
    await p.close();
    execFileSync("sh", ["-c", restartWith], { stdio: "inherit" });
    const q = await page(desktop, `${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`);
    await composer(q).waitFor({ timeout: 60_000 });
    await waitState(q, (x) => x.turnSettings?.who === "subagent" && x.turnSettings?.looser, "the subagent's note after the restart", 45_000);
    await stopsSubagent(q, "sub3.txt");
    ok("restarted while a subagent outlived its turn: found again with its own Full access, note and Stop shown; Stop stopped it");
    await q.close();
  },

  async reviewerAuto() {
    // "Approve for me" (approvalsReviewer auto_review) set by another client (review 6, M1): shown as
    // part of the mode; picking a mode in Tether puts approvals back with you, and asks come as cards.
    rmSync(scratch("rev.txt"), { force: true });
    const p = await page(desktop);
    const r = await rpcVia(p, "newSession", { harness: "codex", projectPath: SCRATCH, model: MODEL, permissionMode: "auto" });
    if (r.error) fail(r.error);
    const id = r.ok.sessionId;
    await rpcVia(p, "setEffort", { sessionId: id, effort: "low" });
    await p.goto(`${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`);
    await composer(p).waitFor({ timeout: 30_000 });
    await send(p, "Reply with just: R0");
    await idle(p);
    helper("set", id.slice(6), JSON.stringify({ approvalsReviewer: "auto_review" }));
    await waitState(p, (x) => x.permissionMode === "auto@codex-reviews", "Approve for me shown", 15_000);
    if (!/Auto \(Codex reviews\)/.test(await p.locator(".t-header").innerText())) fail("the header doesn't say Codex reviews");
    if ((await rpcVia(p, "setPermissionMode", { sessionId: id, mode: "untrusted" })).error) fail("setPermissionMode");
    await send(p, "Use the shell to run exactly: echo rev > rev.txt   Then reply with one word: done.");
    await card(p).waitFor({ timeout: 90_000 });
    await button(card(p), "Deny").click();
    await idle(p, 60_000);
    if (existsSync(scratch("rev.txt"))) fail("rev.txt was written");
    ok('"Approve for me" set elsewhere shows as "Auto (Codex reviews)"; Ask first picked in Tether brought approvals back: the command asked, and was denied');
    await p.close();
  },

  async stored() {
    // Discovery: the session shows in the sidebar and its folder, and opens stored without a process.
    const p = await page(desktop);
    // The page's connection to the runner is up before asking it anything.
    let projects;
    for (let i = 0; i < 60 && !(projects = await rpcVia(p, "listProjects", {})).ok; i++) await sleep(500);
    if (!projects.ok) fail(`listProjects: ${projects.error}`);
    if (!projects.ok.projects.some((x) => x.path === SCRATCH && x.harnesses.includes("codex"))) fail("the scratch folder isn't a Codex project");
    let list;
    for (let i = 0; i < 20 && !(list = await rpcVia(p, "listSessions", { projectPath: SCRATCH })).ok; i++) await sleep(500);
    const row = list.ok.sessions.find((s) => s.id === sessionId());
    if (!row) fail("the session isn't listed in its folder");
    // Its title: the name Codex's TUI gave it, or its first message.
    await p.locator(".t-row", { hasText: row.title.slice(0, 20) }).first().waitFor({ timeout: 30_000 });
    await shot(p, "sidebar-desktop");
    ok(`discovery: the scratch folder is a Codex project and the session is listed in it and in the sidebar ("${row.title}")`);
    await p.close();
  },
};

const pick = process.argv.slice(2);
try {
  for (const name of pick.length ? pick : ["new", "stream", "approve", "deny", "steer", "midturn", "terminal", "tuiApprove", "tetherApprove", "phone", "subagent", "restart", "quit", "fresh", "settings", "storedInject", "restartMid", "subOutlive", "subNewTurn", "subRestart", "subKill9", "reviewerAuto", "netRoots", "bgStop", "bgNote", "nestedStop", "tuiPermissions", "claudeShiftTab", "stored"]) {
    if (!session && !["new", "fresh", "settings", "storedInject", "restartMid", "subOutlive", "subNewTurn", "subRestart", "subKill9", "reviewerAuto", "netRoots", "bgStop", "bgNote", "nestedStop", "tuiPermissions", "claudeShiftTab"].includes(name)) {
      session = process.env.SESSION;
      if (!session) fail(`${name} needs a session: run new first or set SESSION`);
    }
    console.log(`-- ${name}`);
    await steps[name]();
  }
  if (errors.length) fail(`page errors:\n${errors.join("\n")}`);
  console.log(`all passed; screenshots in ${SHOTS}`);
} catch (e) {
  console.error(`FAIL ${e.message}`);
  if (session) console.error(`session: ${session}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
