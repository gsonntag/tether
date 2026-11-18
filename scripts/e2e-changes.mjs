// The Changes pane (SPEC §10 Changes) against a dev runner, desktop (1280) and phone (375). No model
// is needed: sessions are only started, never sent to.
//   PLAYWRIGHT=/path/to/playwright/index.mjs node scripts/e2e-changes.mjs
// Environment:
//   PLAYWRIGHT     Playwright's index.mjs (else the `playwright` package, if it resolves)
//   BASE, RUNNER   the web app and the dev runner's id (README Development: 5180, tether-dev)
//   REPO           a git repo on branch `feature` (off `main`) with uncommitted changes; made fresh
//                  when unset
//   SHOTS          where screenshots go

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:5180";
const RUNNER = process.env.RUNNER ?? "tether-dev";
const SHOTS = process.env.SHOTS ?? "/tmp/tether-changes-shots";
mkdirSync(SHOTS, { recursive: true });

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd, ...a) => execFileSync("git", a, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }).toString();
function makeRepo() {
  const d = mkdtempSync(join(tmpdir(), "tether-changes-"));
  mkdirSync(join(d, "src"));
  writeFileSync(join(d, "src/app.ts"), 'export function greet(name: string) {\n  return "Hello, " + name;\n}\n\nexport const VERSION = "1.0.0";\n');
  writeFileSync(join(d, "legacy.txt"), "to be removed\n");
  git(d, "init", "-q", "-b", "main");
  git(d, "add", ".");
  git(d, "commit", "-qm", "init");
  git(d, "checkout", "-qb", "feature");
  writeFileSync(join(d, "src/app.ts"), 'export function greet(name: string) {\n  return "Hi there, " + name;\n}\n\nexport const VERSION = "1.0.0";\n');
  git(d, "commit", "-qam", "friendlier");
  writeFileSync(join(d, "src/app.ts"), 'export function greet(name: string) {\n  return "Hi there, " + name;\n}\n\nexport function sub(a: number, b: number) {\n  return a - b;\n}\n\nexport const VERSION = "1.1.0";\n');
  git(d, "rm", "-q", "legacy.txt");
  writeFileSync(join(d, "notes.md"), "notes for later\nsecond line, long enough to wrap on a phone: the quick brown fox jumps over the lazy dog again and again\n");
  writeFileSync(join(d, "logo.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));
  return d;
}
const REPO = process.env.REPO ?? makeRepo();
const NOGIT = mkdtempSync(join(tmpdir(), "tether-nogit-"));

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
  await p.locator('button:has-text("New session")').first().waitFor({ timeout: 30_000 });
  return p;
};
async function sessionIn(p, path) {
  const r = await rpcVia(p, "newSession", { harness: "claude", projectPath: path });
  if (r.error) fail(`newSession: ${r.error}`);
  return `${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(r.ok.sessionId)}`;
}
const pane = (p) => p.locator("aside.t-changes");
const fileNames = (p) => pane(p).locator(".t-dfile").evaluateAll((l) => l.map((e) => e.getAttribute("aria-label")));
const line = (p, file, text) => pane(p).locator(`.t-dfile[aria-label="${file}"] .t-dline`, { hasText: text }).first();
const composer = (p) => p.locator("textarea.t-input[aria-label=Message]");

const p = await page(desktop);
const url = await sessionIn(p, REPO);
await p.goto(url);
await p.getByRole("button", { name: "Changes", exact: true }).click();
await pane(p).locator(".t-dfile").first().waitFor({ timeout: 20_000 });
let names = await fileNames(p);
if (names.join() !== "legacy.txt,logo.bin,notes.md,src/app.ts") fail(`uncommitted files: ${names}`);
if (!(await pane(p).locator('.t-dfile[aria-label="logo.bin"]').innerText()).includes("Binary file")) fail("binary not marked");
const box = await pane(p).boundingBox();
if (!box || box.x < 600 || box.width < 300) fail(`pane not beside the transcript: ${JSON.stringify(box)}`);
await shot(p, "desktop-uncommitted");
ok(`desktop: uncommitted files ${names.join(", ")}; pane beside the transcript (${Math.round(box.width)}px)`);

// One line, then a range by Shift-click, then a range by dragging the numbers.
await line(p, "src/app.ts", "export function sub").click();
await pane(p).locator("textarea.t-rform-box").fill("Is sub needed?");
await pane(p).getByRole("button", { name: "Comment", exact: true }).click();
await line(p, "src/app.ts", "1.0.0").click();
await line(p, "src/app.ts", "1.1.0").click({ modifiers: ["Shift"] });
const hint = await pane(p).locator(".t-rform-hint").innerText();
if (!/app\.ts:\d+-\d+/.test(hint) && !/app\.ts:\d+$/.test(hint)) fail(`range hint: ${hint}`);
await pane(p).locator("textarea.t-rform-box").fill("Why bump the version?");
await pane(p).getByRole("button", { name: "Comment", exact: true }).click();
const a = await line(p, "notes.md", "notes for later").locator(".t-dl-num").boundingBox();
const b = await line(p, "notes.md", "second line").locator(".t-dl-num").boundingBox();
await p.mouse.move(a.x + a.width - 8, a.y + a.height / 2);
await p.mouse.down();
await p.mouse.move(b.x + b.width - 8, b.y + b.height / 2, { steps: 5 });
await p.mouse.up();
const dragHint = await pane(p).locator(".t-rform-hint").innerText();
if (!dragHint.includes("notes.md:1-2")) fail(`drag hint: ${dragHint}`);
await pane(p).locator("textarea.t-rform-box").fill("Drop these notes.");
await pane(p).locator("textarea.t-rform-box").press("Control+Enter");
await pane(p).locator(".t-review-count", { hasText: "3 comments" }).waitFor();
await shot(p, "desktop-comments");
ok(`desktop: comments by click, Shift-click (${hint}) and drag (${dragHint}); tray shows 3`);

// Drafts survive a reload.
await p.reload();
await p.getByRole("button", { name: "Changes", exact: true }).click();
await pane(p).locator(".t-review-count", { hasText: "3 comments" }).waitFor({ timeout: 20_000 });
await pane(p).locator(".t-dfile").first().waitFor({ timeout: 20_000 });
if ((await pane(p).locator(".t-dfile .t-rcomment").count()) !== 3) fail("inline comments after reload");
ok("desktop: comments kept across a reload, shown inline");

// Branch scope: the committed change too, against main.
await pane(p).getByRole("tab", { name: "Branch" }).click();
await pane(p).locator(".t-changes-base", { hasText: "feature vs main" }).waitFor({ timeout: 20_000 });
names = await fileNames(p);
if (!names.includes("src/app.ts") || !(await line(p, "src/app.ts", "Hi there").count())) fail(`branch: ${names}`);
if (await line(p, "src/app.ts", "Hello,").count() !== 1) fail("branch scope should show the Hello line as removed");
await shot(p, "desktop-branch");
ok(`desktop: branch scope vs main: ${names.join(", ")}`);

// Refresh picks up a new change.
writeFileSync(join(REPO, "added-later.txt"), "later\n");
await pane(p).getByRole("tab", { name: "Uncommitted" }).click();
await pane(p).locator('.t-dfile[aria-label="notes.md"]').waitFor();
await pane(p).getByRole("button", { name: "Refresh" }).click();
await pane(p).locator('.t-dfile[aria-label="added-later.txt"]').waitFor({ timeout: 10_000 });
ok("desktop: Refresh shows a new file");

// A pick follows its lines through a refresh, and goes when they change.
await line(p, "notes.md", "notes for later").click();
writeFileSync(join(REPO, "added-later.txt"), "later, changed\n");
await pane(p).getByRole("button", { name: "Refresh" }).click();
await pane(p).locator('.t-dfile[aria-label="added-later.txt"] .t-dline', { hasText: "changed" }).waitFor();
if (!(await pane(p).locator(".t-rform-hint").innerText()).includes("notes.md:1")) fail("pick lost on an unrelated refresh");
writeFileSync(join(REPO, "notes.md"), "NOTES for later\nsecond line\n");
await pane(p).getByRole("button", { name: "Refresh" }).click();
await line(p, "notes.md", /NOTES/).waitFor();
if (await pane(p).locator(".t-rform").count()) fail("pick kept on lines that changed");
ok("desktop: a pick follows its lines through Refresh and goes when they change");

// The keyboard: a focused line takes Enter.
await line(p, "src/app.ts", "return a - b").focus();
await p.keyboard.press("Enter");
await pane(p).locator("textarea.t-rform-box").waitFor();
await p.keyboard.press("Escape");
ok("desktop: Enter on a focused line opens a comment");

// Send to agent: one message in the composer; the comments wait, marked, until it's sent.
await pane(p).getByRole("button", { name: "Send to agent" }).click();
const draft = await composer(p).inputValue();
if (!draft.startsWith("Comments on the changes:") || !draft.includes("`notes.md:1-2`") || !draft.includes("Is sub needed?")) fail(`composer: ${draft}`);
await pane(p).locator(".t-review-count", { hasText: "3 in the message box" }).waitFor();
if (await pane(p).getByRole("button", { name: "Send to agent" }).count()) fail("Send to agent still offered");
await pane(p).getByRole("button", { name: "Take back" }).click();
await pane(p).locator(".t-review-count", { hasText: "3 comments" }).waitFor();
while (await pane(p).locator(".t-dfile").getByRole("button", { name: "Remove", exact: true }).count()) await pane(p).locator(".t-dfile").getByRole("button", { name: "Remove", exact: true }).first().click();
await pane(p).locator(".t-review-tray").waitFor({ state: "detached" });
if (git(REPO, "status", "--porcelain").includes("A  notes.md")) fail("the index changed");
await shot(p, "desktop-sent");
ok(`desktop: Send to agent filled the composer (${draft.split("\n").length} lines), comments kept as in the message box, Take back, Remove; index untouched`);
await composer(p).fill("");

// Not a repo.
await p.goto(await sessionIn(p, NOGIT));
await p.getByRole("button", { name: "Changes", exact: true }).click();
await pane(p).getByText("This folder isn't in a git repository.").waitFor({ timeout: 20_000 });
ok("desktop: a folder outside git says so");
await p.close();

// Phone: a sheet over the chat; tap, tap again for a range, send, back to the chat.
const q = await page(phone, url);
await q.getByRole("button", { name: "Changes", exact: true }).tap();
await pane(q).locator(".t-dfile").first().waitFor({ timeout: 20_000 });
const pb = await pane(q).boundingBox();
if (!pb || pb.x !== 0 || pb.width !== 375) fail(`phone pane not full screen: ${JSON.stringify(pb)}`);
await line(q, "src/app.ts", "export function sub").tap();
await line(q, "src/app.ts", "return a - b").tap();
const phint = await pane(q).locator(".t-rform-hint").innerText();
if (!/app\.ts:\d+-\d+/.test(phint)) fail(`phone range: ${phint}`);
await pane(q).locator("textarea.t-rform-box").fill("Rename to subtract.");
await pane(q).getByRole("button", { name: "Comment", exact: true }).tap();
await shot(q, "phone-comment");
await pane(q).locator(".t-review-count").tap();
await shot(q, "phone-tray");
await pane(q).getByRole("button", { name: "Send to agent" }).tap();
await pane(q).waitFor({ state: "detached" });
await q.getByRole("button", { name: "Changes", exact: true }).tap();
await pane(q).locator(".t-review-count", { hasText: "1 in the message box" }).waitFor();
await pane(q).getByRole("button", { name: "Close changes" }).tap();
const pdraft = await composer(q).inputValue();
if (!pdraft.includes("Rename to subtract.")) fail(`phone composer: ${pdraft}`);
await shot(q, "phone-sent");
ok(`phone: full-screen sheet, tap-tap range (${phint}), Send to agent back in the chat with the message`);
await composer(q).fill("");

if (errors.length) fail(`page errors: ${errors.join("; ")}`);
await browser.close();
console.log(`screenshots in ${SHOTS}`);
