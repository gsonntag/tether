// Turn checkpoints (SPEC §10 Checkpoints) against a dev runner and REAL Claude (Haiku, low effort):
// one turn edits, creates and deletes files; the Changes pane's Turn scope shows it; Restore puts
// the files back (ignored and untracked files alone, the index untouched) and Undo restore undoes
// it; a second, slow turn shows as not finished with Restore refused. Desktop, then a phone look.
//   PLAYWRIGHT=/path/to/playwright/index.mjs node scripts/e2e-checkpoints.mjs
// Environment: BASE, RUNNER (the web app and the dev runner's id), SHOTS (screenshots).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const BASE = process.env.BASE ?? "http://127.0.0.1:5193";
const RUNNER = process.env.RUNNER ?? "tether-f3";
const SHOTS = process.env.SHOTS ?? "/tmp/tether-checkpoints-shots";
mkdirSync(SHOTS, { recursive: true });

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd, ...a) => execFileSync("git", a, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }).toString();
const REPO = mkdtempSync(join(tmpdir(), "tether-checkpoints-"));
mkdirSync(join(REPO, "src"));
const APP = 'export function greet(name: string) {\n  return "Hello, " + name;\n}\n';
writeFileSync(join(REPO, "src/app.ts"), APP);
writeFileSync(join(REPO, "notes.md"), "old notes\n");
writeFileSync(join(REPO, ".gitignore"), "*.log\n");
git(REPO, "init", "-q", "-b", "main");
git(REPO, "add", ".");
git(REPO, "commit", "-qm", "init");
writeFileSync(join(REPO, "scratch.txt"), "untracked, kept\n");
writeFileSync(join(REPO, "build.log"), "ignored\n");
const read = (p) => readFileSync(join(REPO, p), "utf8");

const browser = await chromium.launch();
const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
const errors = [];
const ok = (m) => console.log(`ok  ${m}`);
const fail = (m) => {
  throw new Error(m);
};
const shot = (p, name) => p.screenshot({ path: `${SHOTS}/${name}.png` });
const MOD = (name) => `(performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/${name}")) ?? "/src/${name}")`;
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
const page = async (ctx, url = BASE) => {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(url);
  await (url === BASE ? p.locator('button:has-text("New session")').first() : composer(p)).waitFor({ timeout: 30_000 });
  return p;
};
const newSession = async (p) => {
  const r = await rpcVia(p, "newSession", { harness: "claude", projectPath: REPO, model: "haiku", effort: "low", permissionMode: "bypassPermissions" });
  if (r.error) fail(`newSession: ${r.error}`);
  return r.ok.sessionId;
};
const urlOf = (id) => `${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`;
const pane = (p) => p.locator("aside.t-changes");
const fileNames = (p) => pane(p).locator(".t-dfile").evaluateAll((l) => l.map((e) => e.getAttribute("aria-label")));
const composer = (p) => p.locator("textarea.t-input[aria-label=Message]");
const picker = (p) => pane(p).locator("select[aria-label=Turn]");
const status = async (p, id) => (await rpcVia(p, "checkpoints", { sessionId: id })).ok;
async function send(p, text) {
  await composer(p).fill(text);
  await composer(p).press("Enter");
}
async function idle(p, id, ms = 180_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const l = await status(p, id);
    if (l?.checkpoints.length && !l.blocked && !l.checkpoints[0].open) return l;
    await p.waitForTimeout(1000);
  }
  fail("the turn didn't finish");
}

const p = await page(desktop);
const id = await newSession(p);
const other = await newSession(p); // a second live session in the same repo
await p.goto(urlOf(id));
await composer(p).waitFor({ timeout: 30_000 });
await send(p, "Do exactly these three file operations with your tools, then reply 'done' and nothing else: (1) in src/app.ts change \"Hello, \" to \"Hi, \"; (2) create hello.txt containing the single line: hi; (3) delete notes.md (use rm via Bash). Don't run anything else.");
let l = await idle(p, id);
if (read("src/app.ts").includes("Hello") || !existsSync(join(REPO, "hello.txt")) || existsSync(join(REPO, "notes.md"))) fail(`the turn didn't do the edits: ${git(REPO, "status", "--porcelain")}`);
ok(`real turn finished: checkpoint ${JSON.stringify(l.checkpoints[0])}`);
const indexAfterTurn = readFileSync(join(REPO, ".git/index"));

await p.getByRole("button", { name: "Changes", exact: true }).click();
await pane(p).getByRole("tab", { name: "Turn" }).click();
await picker(p).waitFor({ timeout: 20_000 });
await pane(p).locator('.t-dfile[aria-label="hello.txt"]').waitFor({ timeout: 20_000 });
let names = await fileNames(p);
if (names.join() !== "hello.txt,notes.md,src/app.ts") fail(`turn files: ${names}`);
const label = await picker(p).locator("option:checked").innerText();
if (!/Turn 1: Do exactly/.test(label) || !/3 files/.test(label)) fail(`picker label: ${label}`);
const note = await pane(p).locator(".t-turnbar-note").innerText();
if (!note.includes("Also changes the files of")) fail(`no other session named: ${note}`);
await shot(p, "desktop-turn");
ok(`desktop: Turn scope shows ${names.join(", ")}; picker "${label}"; note names the other session`);

// Restore: straight away, no confirm.
await pane(p).getByRole("button", { name: "Restore files to before this turn" }).click();
await pane(p).getByRole("button", { name: "Undo restore" }).waitFor({ timeout: 30_000 });
if (read("src/app.ts") !== APP || existsSync(join(REPO, "hello.txt")) || read("notes.md") !== "old notes\n") fail(`restore didn't put files back: ${git(REPO, "status", "--porcelain")}`);
if (read("scratch.txt") !== "untracked, kept\n" || read("build.log") !== "ignored\n") fail("restore touched untracked or ignored files");
if (!readFileSync(join(REPO, ".git/index")).equals(indexAfterTurn)) fail("the index changed");
if (git(REPO, "status", "--porcelain").trim() !== "?? scratch.txt") fail(`status after restore: ${git(REPO, "status", "--porcelain")}`);
const rl = await picker(p).locator("option:checked").innerText();
if (!rl.includes("Restored to before turn 1")) fail(`restore label: ${rl}`);
await shot(p, "desktop-restored");
ok(`desktop: restored (hello.txt gone, notes.md back, app.ts reverted, scratch.txt and build.log untouched, index the same); picker "${rl}"`);

await pane(p).getByRole("button", { name: "Undo restore" }).click();
await p.waitForFunction(() => document.querySelector('select[aria-label=Turn] option:checked')?.textContent?.includes("Undid"), null, { timeout: 30_000 });
if (read("src/app.ts").includes("Hello") || read("hello.txt").trim() !== "hi" || existsSync(join(REPO, "notes.md"))) fail("undo didn't put the turn's files back");
ok("desktop: Undo restore put the turn's edits back");

// A slow second turn: listed as not finished, Restore refused while it runs.
await send(p, "Run the shell command `sleep 12` with Bash, then reply 'ok'.");
await p.waitForFunction(() => document.querySelector('select[aria-label=Turn] option:checked')?.textContent?.includes("not finished"), null, { timeout: 30_000 });
const btn = pane(p).getByRole("button", { name: "Restore files to before this turn" });
if (!(await btn.isDisabled())) fail("Restore enabled while the turn runs");
const why = await pane(p).locator(".t-turnbar-note").innerText();
const refused = await rpcVia(p, "restoreCheckpoint", { sessionId: id, checkpointId: "1" });
if (!refused.error?.includes("working")) fail(`restore while running: ${JSON.stringify(refused)}`);
await shot(p, "desktop-running");
ok(`desktop: turn 2 running shows "not finished", Restore disabled ("${why.split(".")[0]}."), the op refuses`);
l = await idle(p, id);
ok(`turn 2 finished: ${l.checkpoints.map((c) => `${c.n}:${c.kind}${c.files !== undefined ? `/${c.files}` : ""}`).join(" ")}`);
const refs = git(REPO, "for-each-ref", "--format=%(refname)", "refs/tether/").trim().split("\n");
ok(`refs: ${refs.join(", ")}`);
await p.close();

// Phone: the sheet with the Turn scope.
const q = await page(phone, urlOf(id));
await q.getByRole("button", { name: "Changes", exact: true }).tap();
await pane(q).getByRole("tab", { name: "Turn" }).tap();
await picker(q).waitFor({ timeout: 20_000 });
await picker(q).selectOption("1");
await pane(q).locator('.t-dfile[aria-label="hello.txt"]').waitFor({ timeout: 20_000 });
await shot(q, "phone-turn");
ok("phone: Turn scope, picked turn 1 again");

for (const s of [id, other]) await rpcVia(q, "interrupt", { sessionId: s }).catch(() => {});
if (errors.length) fail(`page errors: ${errors.join("; ")}`);
await browser.close();
console.log(`repo ${REPO}; screenshots in ${SHOTS}`);
