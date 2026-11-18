// Git actions (SPEC §10 Git actions) against a dev runner: a temp repo with a local bare origin and a
// FAKE gh first on the runner's PATH (it answers from files beside it and never reaches GitHub). The
// generated commit message and PR text come from real Claude (Haiku) as a side query on a plan
// session. Checks: the default branch refused until ticked, a commit on a branch, a failing
// pre-commit hook's output, Push, Open PR (pushing first), the PR chip and its checks; desktop, then
// a phone.
//   PLAYWRIGHT=/path/to/playwright/index.mjs FAKE_GH=/tmp/tether-f5-gh node scripts/e2e-git-actions.mjs
// Environment: BASE, RUNNER (the web app and the dev runner's id), SHOTS, FAKE_GH (the fake gh's folder).

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const BASE = process.env.BASE ?? "http://127.0.0.1:5195";
const RUNNER = process.env.RUNNER ?? "tether-f5";
const SHOTS = process.env.SHOTS ?? "/tmp/tether-git-actions-shots";
const GH = process.env.FAKE_GH ?? "/tmp/tether-f5-gh";
mkdirSync(SHOTS, { recursive: true });
// The fake gh, first on the runner's PATH (start the runner with PATH=$FAKE_GH:$PATH). It answers from
// files beside it and logs every call; it never reaches GitHub.
mkdirSync(GH, { recursive: true });
writeFileSync(
  join(GH, "gh"),
  `#!/bin/sh
D="${GH}"
printf '%s\\n' "$*" >> "$D/calls"
case "$1 $2" in
  "repo view") printf '{"nameWithOwner":"example/demo","url":"https://github.com/example/demo"}'; exit 0;;
  "auth status") echo "github.com: Logged in (fake)"; exit 0;;
  "pr view") [ -e "$D/pr.json" ] && { cat "$D/pr.json"; exit 0; }; echo "no pull requests found for branch \\"$3\\"" >&2; exit 1;;
  "pr create")
    printf '{"number":42,"url":"https://github.com/example/demo/pull/42","title":"from fake gh","state":"OPEN","isDraft":false,"headRefName":"feature","statusCheckRollup":[{"__typename":"CheckRun","status":"IN_PROGRESS","conclusion":""}]}' > "$D/pr.json"
    echo "https://github.com/example/demo/pull/42"; exit 0;;
esac
echo "fake gh: unsupported: $*" >&2
exit 2
`,
);
chmodSync(join(GH, "gh"), 0o755);
for (const f of ["calls", "pr.json"]) rmSync(join(GH, f), { force: true });
const ghCalls = () => (existsSync(join(GH, "calls")) ? readFileSync(join(GH, "calls"), "utf8").trim().split("\n") : []);

const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const ORIGIN = mkdtempSync(join(tmpdir(), "tether-git-origin-"));
const REPO = mkdtempSync(join(tmpdir(), "tether-git-actions-"));
git(ORIGIN, "init", "-q", "--bare", "-b", "main");
git(REPO, "init", "-q", "-b", "main");
git(REPO, "config", "user.name", "Tess Ter");
git(REPO, "config", "user.email", "tess@example.com");
writeFileSync(join(REPO, "greet.ts"), 'export function greet(name: string) {\n  return "Hello, " + name;\n}\n');
writeFileSync(join(REPO, ".gitignore"), "*.log\n");
git(REPO, "add", ".");
git(REPO, "commit", "-qm", "Add greet");
git(REPO, "remote", "add", "origin", ORIGIN);
git(REPO, "push", "-q", "-u", "origin", "main");
git(REPO, "remote", "set-head", "origin", "main");
// origin through an ssh host alias (gh resolves it, not Tether); pushes go to the bare one
git(REPO, "remote", "set-url", "origin", "git@github-work:example/demo.git");
git(REPO, "config", "remote.origin.pushurl", ORIGIN);

const browser = await chromium.launch();
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
const urlOf = (id) => `${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(id)}`;
const composer = (p) => p.locator("textarea.t-input[aria-label=Message]");
const bar = (p) => p.locator(".t-gitbar");
const branch = (p) => bar(p).locator(".t-gitbar-branch");
/** Refresh, then the pointer off it (its tooltip would cover the bar's buttons) */
const refresh = async (p) => {
  await p.locator("aside.t-changes").getByRole("button", { name: "Refresh" }).click();
  await p.mouse.move(1, 1);
};
const btn = (p, name) => bar(p).locator(".t-gitbar-buttons").getByRole("button", { name, exact: true });
async function until(f, what, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`timed out: ${what}`);
}
const open = async (ctx, id) => {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(urlOf(id));
  await composer(p).waitFor({ timeout: 30_000 });
  return p;
};

try {
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const home = await desktop.newPage();
  await home.goto(BASE);
  await home.locator('button:has-text("New session")').first().waitFor({ timeout: 30_000 });
  const made = await rpcVia(home, "newSession", { harness: "claude", projectPath: REPO, model: "haiku", effort: "low" });
  if (made.error) fail(`newSession: ${made.error}`);
  const id = made.ok.sessionId;
  await home.close();

  // ---- the default branch: refused until ticked ----
  writeFileSync(join(REPO, "greet.ts"), 'export function greet(name: string) {\n  return `Hello, ${name}!`;\n}\n');
  writeFileSync(join(REPO, "farewell.ts"), 'export const bye = (name: string) => `Bye, ${name}`;\n');
  writeFileSync(join(REPO, "debug.log"), "ignored\n");
  const p = await open(desktop, id);
  await p.getByRole("button", { name: "Changes" }).click();
  await until(async () => (await branch(p).textContent())?.includes("main → origin/main · up to date"), "branch line on main");
  ok(`branch line: ${await branch(p).textContent()}`);
  await btn(p, "Commit").click();
  const msg = bar(p).locator("textarea[aria-label='Commit message']");
  await until(async () => (await msg.inputValue()).trim().length > 0, "a generated commit message", 90_000);
  ok(`generated commit message: ${JSON.stringify(await msg.inputValue())}`);
  const tick = bar(p).getByLabel("Commit to main anyway");
  await tick.waitFor();
  const commitBtn = bar(p).locator(".t-gitbar-box").getByRole("button", { name: "Commit", exact: true });
  if (!(await commitBtn.isDisabled())) fail("Commit isn't disabled on main before the tick");
  await shot(p, "1-commit-on-main-refused");
  ok("on main: Commit waits for “Commit to main anyway”");
  const refused = await rpcVia(p, "gitCommit", { sessionId: id, message: "x" });
  if (refused.ok?.ok !== false || !/anyway/.test(refused.ok.error)) fail(`runner didn't refuse main: ${JSON.stringify(refused)}`);
  ok(`runner refuses too: ${refused.ok.error}`);
  await bar(p).getByRole("button", { name: "Cancel" }).click();
  if (await bar(p).getByLabel("Push to main anyway").count()) fail("push tick shows with nothing to push");

  // ---- a branch: commit with the generated message ----
  git(REPO, "checkout", "-qb", "feature");
  await refresh(p);
  await until(async () => (await branch(p).textContent()) === "feature · not pushed", "branch line on feature");
  await btn(p, "Commit").click();
  if (!(await msg.inputValue()).trim()) await until(async () => (await msg.inputValue()).trim().length > 0, "the message", 90_000);
  if (await tick.count()) fail("the tick shows off the default branch");
  const message = await msg.inputValue();
  await commitBtn.click();
  await until(async () => (await bar(p).locator(".t-gitbar-done").count()) > 0, "Committed");
  ok(`${await bar(p).locator(".t-gitbar-done").textContent()}`);
  if (git(REPO, "log", "-1", "--format=%B") !== message.trim()) fail("the commit's message isn't the box's");
  if (git(REPO, "log", "-1", "--format=%an <%ae>") !== "Tess Ter <tess@example.com>") fail("not git's identity");
  if (git(REPO, "show", "--name-only", "--format=", "HEAD").split("\n").sort().join(",") !== "farewell.ts,greet.ts") fail("commit didn't take what Uncommitted showed");
  await until(async () => (await p.locator(".t-changes-note").allTextContents()).some((t) => t.includes("No uncommitted changes")), "Uncommitted empty");
  ok("committed everything in Uncommitted, ignored file left; pane reloaded");
  await shot(p, "2-committed");

  // ---- a failing pre-commit hook shows its output ----
  const hook = join(REPO, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'lint: greet.ts:2 prefer const' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  writeFileSync(join(REPO, "greet.ts"), "export const greet = (name: string) => `Hi, ${name}`;\n");
  await refresh(p);
  await until(async () => !(await btn(p, "Commit").isDisabled()), "Commit enabled");
  await btn(p, "Commit").click();
  await msg.fill("Shorter greet");
  await commitBtn.click();
  await until(async () => (await bar(p).locator(".t-gitbar-failed").count()) > 0, "the hook's failure");
  const out = await bar(p).locator(".t-gitbar-output").textContent();
  if (!out?.includes("prefer const")) fail(`hook output not shown: ${out}`);
  ok(`hook refusal: ${await bar(p).locator(".t-gitbar-failed > div").first().textContent()} / ${out}`);
  await shot(p, "3-hook-failed");
  rmSync(hook);
  await commitBtn.click();
  await until(async () => (await bar(p).locator(".t-gitbar-done").count()) > 0, "Committed after the hook went");

  // ---- push ----
  await btn(p, "Push").click();
  await until(async () => (await bar(p).locator(".t-gitbar-done").textContent())?.includes("Pushed to origin/feature"), "Pushed");
  await until(async () => (await branch(p).textContent()) === "feature → origin/feature · up to date", "up to date");
  if (git(ORIGIN, "rev-parse", "feature") !== git(REPO, "rev-parse", "HEAD")) fail("origin doesn't have the branch");
  ok("pushed to the bare origin with -u; up to date");

  // ---- one more commit outside: ahead 1; Open PR pushes first ----
  writeFileSync(join(REPO, "README.md"), "# Demo\n\ngreet and bye.\n");
  git(REPO, "add", ".");
  git(REPO, "commit", "-qm", "Add a README");
  await refresh(p);
  await until(async () => (await branch(p).textContent()) === "feature → origin/feature · 1 ahead", "1 ahead");
  ok("ahead shows: feature → origin/feature · 1 ahead");
  await btn(p, "Open PR").click();
  const title = bar(p).locator("input[aria-label='PR title']");
  await until(async () => (await title.inputValue()).trim().length > 0, "a generated PR title", 90_000);
  const body = await bar(p).locator("textarea[aria-label='PR description']").inputValue();
  ok(`generated PR: ${JSON.stringify(await title.inputValue())} / ${JSON.stringify(body.slice(0, 120))}…`);
  await title.fill(`${await title.inputValue()} (edited)`);
  await shot(p, "4-open-pr");
  await bar(p).locator(".t-gitbar-box").getByRole("button", { name: "Open PR", exact: true }).click();
  await until(async () => (await bar(p).locator(".t-gitbar-done").textContent())?.includes("Opened #42"), "Opened #42");
  if (git(ORIGIN, "rev-parse", "feature") !== git(REPO, "rev-parse", "HEAD")) fail("Open PR didn't push first");
  const create = ghCalls().find((c) => c.startsWith("pr create"));
  if (!create?.startsWith("pr create --base main --head feature --title ") || !create.includes("(edited)")) fail(`gh pr create args: ${create}`);
  if (!ghCalls().some((c) => c.startsWith("pr view example:feature ") && c.endsWith("--repo example/demo"))) fail("lookup by owner:branch in gh's repo");
  if (!ghCalls().includes("auth status --hostname github.com")) fail("gh auth status wasn't asked of origin's host");
  ok(`fake gh: ${create.slice(0, 90)}…`);
  const chip = p.locator("a.t-chip-pr");
  await until(async () => (await chip.textContent()) === "#42 · Open · ●", "the PR chip, checks running");
  if ((await chip.getAttribute("href")) !== "https://github.com/example/demo/pull/42") fail("chip link");
  ok(`chip: ${await chip.textContent()} (${await chip.getAttribute("title")})`);
  if (!(await btn(p, "Open PR").isDisabled())) fail("Open PR still enabled with #42 open");
  await shot(p, "5-pr-chip");

  // ---- checks pass: a fresh lookup, then the session opened again shows it ----
  writeFileSync(join(GH, "pr.json"), JSON.stringify({ number: 42, url: "https://github.com/example/demo/pull/42", title: "from fake gh", state: "OPEN", isDraft: false, headRefName: "feature", statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }));
  await rpcVia(p, "gitPr", { sessionId: id, fresh: true });
  const views = ghCalls().filter((c) => c.startsWith("pr view")).length;
  await p.reload();
  await until(async () => (await chip.textContent()) === "#42 · Open · ✓", "checks passing");
  if (ghCalls().filter((c) => c.startsWith("pr view")).length !== views) fail("opening the session asked gh again inside the cache");
  ok("chip: #42 · Open · ✓, from the runner's cache (no extra gh call)");

  // ---- phone ----
  const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  const q = await open(phone, id);
  await q.locator("a.t-chip-pr").waitFor();
  await shot(q, "6-phone-header");
  await q.getByRole("button", { name: "Changes" }).click();
  await until(async () => (await branch(q).textContent())?.startsWith("feature → origin/feature"), "phone branch line");
  const sw = await q.evaluate(() => document.documentElement.scrollWidth);
  if (sw > 375) fail(`phone scrolls sideways (${sw})`);
  await btn(q, "Commit").isVisible();
  await shot(q, "7-phone-pane");
  writeFileSync(join(REPO, "farewell.ts"), "export const bye = (n: string) => `See you, ${n}`;\n");
  await q.locator("aside.t-changes").getByRole("button", { name: "Refresh" }).tap();
  await until(async () => !(await btn(q, "Commit").isDisabled()), "phone Commit enabled");
  await btn(q, "Commit").click();
  await until(async () => (await bar(q).locator("textarea[aria-label='Commit message']").inputValue()).trim().length > 0, "phone generated message", 90_000);
  await shot(q, "8-phone-commit-box");
  ok("phone: chip in the header, git bar in the sheet, commit box drafted, no sideways scroll");

  if (errors.length) fail(`page errors: ${errors.join("; ")}`);
  console.log(`\nall good; screenshots in ${SHOTS}`);
} finally {
  await browser.close();
  rmSync(REPO, { recursive: true, force: true });
  rmSync(ORIGIN, { recursive: true, force: true });
}
