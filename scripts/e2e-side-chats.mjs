// Side chats (SPEC §16a), real Claude Code (Haiku, Low) and the real Codex daemon (CODEX_MODEL, Low),
// desktop (1280) and phone (375):
//   PLAYWRIGHT=/path/to/playwright/index.mjs node scripts/e2e-side-chats.mjs [step…]
// Needs a server, a dev runner and vite (docs/acceptance/P6-move.md Setup, with this script).
// Environment: BASE, RUNNER, SCRATCH (the folder sessions start in), SHOTS, CODEX_MODEL.
// Steps:
//   claude  desktop: /btw while the main turn runs opens the panel on a read-only fork that answers
//           from the conversation; asked to write a file it can't; Bring back fills the main box;
//           the side chat is in no list; closing archives it; Side chats opens it again
//   phone   the same session on a phone: Side chat from the menu is a sheet over the session;
//           Bring back tucks it away with the summary in the box
//   codex   on a phone: /btw on Codex, which can't write either

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const BASE = process.env.BASE ?? "http://127.0.0.1:5197";
const RUNNER = process.env.RUNNER ?? "tether-f7";
const SHOTS = process.env.SHOTS ?? "/tmp/tether-f7-shots";
const SCRATCH = process.env.SCRATCH ?? "/tmp/tether-f7-scratch";
const CODEX_MODEL = process.env.CODEX_MODEL ?? "gpt-5.6-luna";
mkdirSync(SHOTS, { recursive: true });
mkdirSync(SCRATCH, { recursive: true });

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
const ok = (m) => console.log(`ok  ${m}`);
const fail = (m) => {
  throw new Error(m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const token = (w) => `${w}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const mainBox = (p) => p.locator(".t-session textarea.t-input");
const sideBox = (p) => p.locator(".t-side-chat textarea.t-input");
const MOD = (name) => `(performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/${name}")) ?? "/src/${name}")`;
const sessionUrl = (id) => `${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`;
const tap = (p) => p.context() === phone;
const press = async (p, l) => (tap(p) ? l.tap() : l.click());
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
/** A session's view in the page's store (the main one, or a side chat's in the panel). */
const viewOf = (p, id) =>
  p.evaluate(
    async ([store, id]) => {
      const { useStore } = await import(eval(store));
      const v = Object.entries(useStore.getState().views).find(([k]) => k.endsWith(`\u0000${id}`))?.[1];
      return v ? { state: v.state, messages: v.window?.messages ?? [] } : null;
    },
    [MOD("store.ts"), id],
  );
const waitFor = async (what, f, ms = 120_000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await f();
    if (last) return last;
    await sleep(400);
  }
  fail(`${what}${last === undefined ? "" : `: ${JSON.stringify(last)}`}`);
};
const textOf = (m) => (m?.parts ?? []).map((x) => x.text ?? "").join("\n");
const replies = (v) => (v?.messages ?? []).filter((m) => m.role === "assistant" && !m.streaming);
/** Waits for the session to be idle with a reply after `n` replies; that reply's text. */
async function replyAfter(p, id, n, ms = 180_000) {
  const v = await waitFor(`a reply in ${id}`, async () => {
    const v = await viewOf(p, id);
    if (v?.state?.requests?.length) fail(`${id} asked for ${v.state.requests[0].tool}`);
    return v?.state?.status === "idle" && replies(v).length > n ? v : undefined;
  }, ms);
  return textOf(replies(v).at(-1));
}
const send = async (p, box, text) => {
  await box.fill(text);
  if (tap(p)) await box.locator("xpath=ancestor::*[contains(@class,'t-composer')][1]").getByRole("button", { name: "Send" }).tap();
  else await box.press("Enter");
};
const newSession = async (p, harness) => {
  const r = await rpcVia(p, "newSession", { harness, projectPath: SCRATCH, model: harness === "codex" ? CODEX_MODEL : "haiku", effort: "low", permissionMode: harness === "codex" ? "auto" : "acceptEdits" });
  if (r.error) fail(r.error);
  const id = r.ok.sessionId;
  await p.goto(sessionUrl(id));
  await mainBox(p).waitFor({ timeout: 30_000 });
  return id;
};
const sideChats = async (p, id) => {
  const r = await rpcVia(p, "listSessions", { sideOf: id });
  if (r.error) fail(r.error);
  return r.ok.sessions;
};
const noOverflow = async (p, where) => {
  const w = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (w > 1) fail(`${where}: page scrolls sideways by ${w}px`);
};
/** The side chat the panel shows, once it's made. */
const panelSide = async (p, main, before = []) => {
  await p.locator(".t-side-chat").waitFor({ timeout: 10_000 });
  const s = await waitFor("the side chat made", async () => (await sideChats(p, main)).find((x) => !before.includes(x.id)));
  await p.locator(".t-side-chat .t-side-title", { hasText: "Side chat" }).waitFor({ timeout: 30_000 });
  return s;
};
/** Asks it to write a file: refused, and the file isn't there. */
async function cantWrite(p, side, n, file, shell = false) {
  rmSync(join(SCRATCH, file), { force: true });
  await send(p, sideBox(p), shell ? `Run exactly this shell command now, with your shell tool, and tell me what happened: echo hello > ${file}` : `Create a file named ${file} in the current folder containing the word hello. Use your file-writing tool or a shell command; do it now, don't plan.`);
  const r = await replyAfter(p, side, n);
  await sleep(1500);
  if (existsSync(join(SCRATCH, file))) fail(`the side chat wrote ${file}: ${r}`);
  return r;
}
/** Bring back: the main box gets the summary. */
async function bringBack(p) {
  await press(p, p.locator(".t-side-chat").getByRole("button", { name: "Bring back" }));
  return waitFor("Bring back filled the box", async () => {
    const v = await mainBox(p).inputValue();
    return v.startsWith("From a side chat:") ? v : undefined;
  }, 150_000);
}

/** Tether's peers MCP servers this runner's Codex threads run (one per loaded thread; Codex's say `codex:*`). */
const codexPeerServers = () =>
  readdirSync("/proc")
    .filter((d) => /^\d+$/.test(d))
    .filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("tether-f7/runner/src/modules/peers/mcp.ts") && readFileSync(`/proc/${pid}/environ`, "utf8").includes("TETHER_PEERS_ID=codex:*");
      } catch {
        return false;
      }
    }).length;

let claudeMain;
let claudeWord;

const steps = {
  async claude() {
    const p = await page(desktop);
    const id = await newSession(p, "claude");
    claudeMain = id;
    claudeWord = token("ALPHA");
    await send(p, mainBox(p), `Remember the code word ${claudeWord}. Reply with exactly: noted. Do not use tools.`);
    await replyAfter(p, id, 0);
    // A long main turn; the side chat comes while it runs.
    await send(p, mainBox(p), "Count from 1 to 1500, one number a line, then say done. Do not use tools.");
    await waitFor("the long turn running", async () => (await viewOf(p, id))?.state?.status === "running", 60_000);
    // /btw is first in the menu.
    await mainBox(p).fill("/bt");
    await p.locator("#t-command-btw").waitFor({ timeout: 15_000 }).catch(() => fail("/btw isn't in the / menu"));
    await send(p, mainBox(p), "/btw What code word did I ask you to remember? Reply with only the word.");
    const side = await panelSide(p, id);
    const runningThen = (await viewOf(p, id)).state.status === "running";
    ok(`/btw opened ${side.id} beside ${id}${runningThen ? " while the main turn ran" : ""}`);
    const answer = await replyAfter(p, side.id, 1);
    if (!answer.includes(claudeWord)) fail(`the side chat doesn't know the word: ${answer}`);
    const sv = await viewOf(p, side.id);
    if (sv.state.permissionMode !== "default") fail(`the side chat runs in ${sv.state.permissionMode}`);
    const main = await viewOf(p, id);
    if (!runningThen) fail("the main turn wasn't running when the side chat opened");
    if (main.state.error) fail(`the main turn failed: ${main.state.error}`);
    if (JSON.stringify(main.messages).includes("/btw")) fail("/btw reached the main session");
    await shot(p, "claude-side-answered");
    ok(`the side chat answered (${answer.trim()}) in its read-only mode (Ask first + the gate); the main turn ${main.state.status === "running" ? "still runs" : "ran undisturbed"}`);

    const refused = await cantWrite(p, side.id, replies(sv).length, `side-${Date.now()}.txt`);
    await shot(p, "claude-side-refused");
    ok(`asked to write, it didn't: ${refused.replace(/\s+/g, " ").slice(0, 160)}`);
    const viaShell = await cantWrite(p, side.id, replies(await viewOf(p, side.id)).length, `side-sh-${Date.now()}.txt`, true);
    ok(`asked to run a writing shell command, it didn't: ${viaShell.replace(/\s+/g, " ").slice(0, 160)}`);
    const tries = await rpcVia(p, "setPermissionMode", { sessionId: side.id, mode: "acceptEdits" });
    if (!tries.error?.includes("stays read-only")) fail(`its mode changed: ${JSON.stringify(tries)}`);
    ok("its mode can't change");

    // In no list: Recent (the page's), the projects' sessions.
    const listed = await p.evaluate(async ([store, list]) => {
      const { useStore } = await import(eval(store));
      const { recentSessions, inbox } = await import(eval(list));
      const s = useStore.getState().summaries;
      return [...recentSessions(s), ...inbox(s)].map((r) => r.id);
    }, [MOD("store.ts"), MOD("sessionList.ts")]);
    if (listed.includes(side.id)) fail("the side chat is in Recent or Home");
    const inFolder = await rpcVia(p, "listSessions", { projectPath: SCRATCH });
    if (inFolder.ok.sessions.some((s) => s.id === side.id)) fail("the side chat is in its project's list");
    ok("the side chat is in no list");

    await rpcVia(p, "interrupt", { sessionId: id });
    await waitFor("the long turn stopped", async () => (await viewOf(p, id))?.state?.status === "idle", 60_000);
    const draft = await bringBack(p);
    await shot(p, "claude-brought-back");
    ok(`Bring back filled the main box: ${draft.replace(/\s+/g, " ").slice(0, 160)}`);

    await press(p, p.getByRole("button", { name: "Close side chat" }));
    await p.locator(".t-side-chat").waitFor({ state: "detached", timeout: 10_000 });
    await waitFor("closing archived it", async () => (await sideChats(p, id)).find((s) => s.id === side.id)?.archived);
    ok("closing archived it");
    await press(p, p.getByRole("button", { name: /^Side chats/ }));
    await press(p, p.getByRole("menuitem", { name: /\(closed\)/ }).first());
    await p.locator(".t-side-chat .t-msg.assistant").first().waitFor({ timeout: 30_000 });
    await waitFor("reopening unarchived it", async () => (await sideChats(p, id)).find((s) => s.id === side.id)?.archived !== true);
    await shot(p, "claude-reopened");
    ok("Side chats opens it again");
    await press(p, p.getByRole("button", { name: "Close side chat" }));
    await mainBox(p).fill("");
  },

  async phone() {
    if (!claudeMain) fail("run the claude step first");
    const p = await page(phone, sessionUrl(claudeMain));
    await mainBox(p).waitFor({ timeout: 30_000 });
    const before = (await sideChats(p, claudeMain)).map((s) => s.id);
    await press(p, p.getByRole("button", { name: "Session menu" }));
    await press(p, p.getByRole("menuitem", { name: "Side chat", exact: true }));
    const side = await panelSide(p, claudeMain, before);
    const box = await p.locator(".t-side-chat").boundingBox();
    if (box.width < 370 || box.height < 700) fail(`the side chat isn't a sheet over the session: ${JSON.stringify(box)}`);
    await noOverflow(p, "the side chat on a phone");
    await sideBox(p).waitFor({ timeout: 30_000 });
    const n = replies(await viewOf(p, side.id)).length;
    await send(p, sideBox(p), "What code word did I ask you to remember? Reply with only the word.");
    const answer = await replyAfter(p, side.id, n);
    if (!answer.includes(claudeWord)) fail(`the phone's side chat doesn't know the word: ${answer}`);
    await shot(p, "phone-side");
    if ((await p.locator(".t-side-chat").getAttribute("role")) !== "dialog") fail("the phone's sheet isn't a dialog");
    await p.keyboard.press("Escape");
    await p.locator(".t-side-chat").waitFor({ state: "detached", timeout: 10_000 });
    if ((await sideChats(p, claudeMain)).find((s) => s.id === side.id)?.archived) fail("Escape archived it");
    await press(p, p.getByRole("button", { name: /^Side chats/ }));
    await press(p, p.getByRole("menuitem", { name: side.title }).first());
    await p.locator(".t-side-chat").waitFor({ timeout: 10_000 });
    ok("Escape tucks the sheet away; Side chats brings it back");
    const draft = await bringBack(p);
    await p.locator(".t-side-chat").waitFor({ state: "detached", timeout: 10_000 });
    if (!(await mainBox(p).isVisible())) fail("the main box isn't showing after Bring back");
    await shot(p, "phone-brought-back");
    ok(`on a phone: a sheet over the session; Bring back tucked it away: ${draft.replace(/\s+/g, " ").slice(0, 120)}`);
    // Tucked away, not closed: still open under Side chats.
    if ((await sideChats(p, claudeMain)).find((s) => s.id === side.id)?.archived) fail("Bring back archived it");
    await rpcVia(p, "setSessionArchived", { sessionId: side.id, archived: true });
  },

  async codex() {
    const p = await page(phone);
    const id = await newSession(p, "codex");
    const word = token("CHARLIE");
    await send(p, mainBox(p), `Remember the code word ${word}. Reply with exactly: noted. Do not run any commands.`);
    await replyAfter(p, id, 0);
    const before = codexPeerServers();
    await send(p, mainBox(p), "/btw What code word did I ask you to remember? Reply with only the word.");
    const side = await panelSide(p, id);
    const answer = await replyAfter(p, side.id, 1);
    if (!answer.includes(word)) fail(`the Codex side chat doesn't know the word: ${answer}`);
    const sv = await viewOf(p, side.id);
    const after = codexPeerServers();
    if (before < 1) fail("the main Codex thread runs no Tether MCP server (nothing to compare with)");
    if (after !== before) fail(`the Codex side chat got Tether's MCP server (${before} → ${after})`);
    ok(`the Codex side chat runs no MCP server of Tether's (${before} before, ${after} after; its session has one)`);
    if (sv.state.permissionMode !== "never+read-only") fail(`the Codex side chat runs in ${sv.state.permissionMode}`);
    const refused = await cantWrite(p, side.id, replies(sv).length, `side-codex-${Date.now()}.txt`);
    await shot(p, "codex-side-refused");
    ok(`Codex: answered (${answer.trim()}) in never+read-only; asked to write, it didn't: ${refused.replace(/\s+/g, " ").slice(0, 160)}`);
    const viaShell = await cantWrite(p, side.id, replies(await viewOf(p, side.id)).length, `side-codex-sh-${Date.now()}.txt`, true);
    ok(`Codex: asked to run a writing shell command, it didn't: ${viaShell.replace(/\s+/g, " ").slice(0, 160)}`);
    await press(p, p.getByRole("button", { name: "Close side chat" }));
    await waitFor("closing archived it", async () => (await sideChats(p, id)).find((s) => s.id === side.id)?.archived);
    ok("codex on a phone");
  },
};

try {
  for (const s of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(steps)) {
    console.log(`-- ${s}`);
    await steps[s]();
  }
  if (errors.length) fail(`page errors: ${errors.join("; ")}`);
  console.log("all ok");
} finally {
  await browser.close();
}
