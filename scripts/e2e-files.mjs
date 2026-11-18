// The Files tab (SPEC §10 Files) against a dev runner, desktop (1280) and phone (375). No model is
// needed: sessions are only started, never sent to.
//   PLAYWRIGHT=/path/to/playwright/index.mjs BASE=http://127.0.0.1:5180 RUNNER=tether-dev node scripts/e2e-files.mjs
// A temp repo is made with Markdown, an image, an SVG with a script, a binary, a file over 1 MB, an
// ignored folder, a dot file and a link to a file outside the folder.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:5180";
const RUNNER = process.env.RUNNER ?? "tether-dev";
const SHOTS = process.env.SHOTS ?? "/tmp/tether-files-shots";
mkdirSync(SHOTS, { recursive: true });

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd, ...a) => execFileSync("git", a, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }).toString();

/** A 48×48 PNG: a gradient, so it's plainly an image. */
function png() {
  const w = 48;
  const crc = (b) => {
    let c = ~0;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (t, d) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < w; y++) {
    rows.push(0);
    for (let x = 0; x < w; x++) rows.push(x * 5, y * 5, 200);
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))]);
}

function makeRepo() {
  const base = mkdtempSync(join(tmpdir(), "tether-files-"));
  const d = join(base, "proj");
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(base, "outside-secret.txt"), "never shown\n");
  writeFileSync(join(d, "README.md"), "# Files demo\n\nA **bold** claim and a list:\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\n\nSee [the app](src/app.ts), [the sources](src) and [escape](../outside-secret.txt). Jump to [the end](#the-end).\n\n" + "filler\n\n".repeat(80) + "## The end\n\nDone.\n");
  writeFileSync(join(d, "src/trojan.ts"), 'const ok = "user\u202e \u2066// admin\u2069 \u2066";\n');
  writeFileSync(join(d, "src/app.ts"), Array.from({ length: 60 }, (_, i) => `export const line${i + 1} = ${i + 1}; // a fairly long line so that it scrolls sideways on a phone screen`).join("\n") + "\n");
  writeFileSync(join(d, "logo.png"), png());
  writeFileSync(join(d, "pic.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><script>alert("svg ran")</script><circle cx="40" cy="40" r="30" fill="tomato"/></svg>');
  writeFileSync(join(d, "blob.bin"), Buffer.from([0, 1, 2, 3, 4, 5, 0, 7]));
  writeFileSync(join(d, "big.txt"), "a line of a big file\n".repeat(80_000));
  writeFileSync(join(d, ".env"), "TOKEN=abc\n");
  writeFileSync(join(d, ".gitignore"), "ignored/\n");
  mkdirSync(join(d, "ignored"));
  writeFileSync(join(d, "ignored/cache.txt"), "cache\n");
  symlinkSync(join(base, "outside-secret.txt"), join(d, "out-link"));
  git(d, "init", "-q", "-b", "main");
  git(d, "add", ".");
  git(d, "commit", "-qm", "init");
  return d;
}
const REPO = makeRepo();

const browser = await chromium.launch();
const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
const errors = [];
const dialogs = [];
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
  p.on("dialog", (d) => (dialogs.push(d.message()), d.dismiss()));
  await p.goto(url);
  await p.locator('button:has-text("New session")').first().waitFor({ timeout: 30_000 });
  return p;
};
const pane = (p) => p.locator("aside.t-changes");
const row = (p, name) => pane(p).locator(".t-files-row", { has: p.locator(".t-files-name", { hasText: new RegExp(`^${name.replace(/\./g, "\\.")}$`) }) });
const treeNames = (p) => pane(p).locator('[role="tree"] .t-files-name').allInnerTexts();
const composer = (p) => p.locator("textarea.t-input[aria-label=Message]");

const p = await page(desktop);
const r = await rpcVia(p, "newSession", { harness: "claude", projectPath: REPO });
if (r.error) fail(`newSession: ${r.error}`);
const sessionId = r.ok.sessionId;
const url = `${BASE}/#/s/${encodeURIComponent(RUNNER)}/${encodeURIComponent(sessionId)}`;
await p.goto(url);
await p.getByRole("button", { name: "Changes", exact: true }).click();
await pane(p).getByRole("tab", { name: "Files" }).click();
await row(p, "README.md").waitFor({ timeout: 20_000 });
let names = await treeNames(p);
if (names.join() !== "src,big.txt,blob.bin,logo.png,out-link,pic.svg,README.md") fail(`tree: ${names}`);
// One tab stop; arrows move; Right opens a folder, Left closes it.
if ((await pane(p).locator('[role="treeitem"][tabindex="0"]').count()) !== 1) fail("one tab stop");
await pane(p).locator('[role="treeitem"][tabindex="0"]').focus();
await p.keyboard.press("ArrowDown");
if ((await p.evaluate(() => document.activeElement?.textContent)).indexOf("big.txt") < 0) fail("ArrowDown");
await p.keyboard.press("Home");
await p.keyboard.press("ArrowRight");
await row(p, "app.ts").waitFor();
await p.keyboard.press("ArrowLeft");
await row(p, "app.ts").waitFor({ state: "detached" });
await p.keyboard.press("End");
await p.keyboard.press("Enter");
await pane(p).locator(".t-files-path", { hasText: "README.md" }).waitFor();
await pane(p).getByRole("button", { name: "Back to files" }).click();
if (!(await p.evaluate(() => document.activeElement?.getAttribute("role") === "treeitem" && document.activeElement.textContent.includes("README.md")))) fail("Back should return focus to the row");
ok("desktop: tree keyboard: one tab stop, arrows, Right/Left, End, Enter opens; Back returns focus");
if ((await row(p, "out-link").getAttribute("aria-disabled")) !== "true") fail("a link out should not open");
if (!(await row(p, "out-link").innerText()).includes("points outside the folder")) fail("link out not said");
await shot(p, "desktop-tree");
ok(`desktop: tree ${names.join(", ")}; .env and ignored/ hidden; out-link listed, can't open`);

// Hidden: dot files and ignored files, dimmed.
await pane(p).getByRole("button", { name: "Show hidden files" }).click();
await row(p, ".env").waitFor();
await row(p, "ignored").waitFor();
if (!(await row(p, "ignored").getAttribute("class")).includes("dim")) fail("ignored not dimmed");
names = await treeNames(p);
if (names.includes(".git")) fail(".git listed");
await row(p, "ignored").locator(".t-files-item").click();
await row(p, "cache.txt").waitFor();
await shot(p, "desktop-hidden");
ok(`desktop: hidden toggle shows ${names.filter((n) => n.startsWith(".") || n === "ignored").join(", ")} (dimmed), never .git`);
await pane(p).getByRole("button", { name: "Hide hidden files" }).click();
await p.waitForFunction(() => ![...document.querySelectorAll('[role="tree"] .t-files-name')].some((e) => e.textContent === ".env"));

// Text with line numbers.
await row(p, "src").locator(".t-files-item").click();
await row(p, "app.ts").locator(".t-files-item").click();
await pane(p).locator(".t-files-text").waitFor();
const gutter = await pane(p).locator(".t-files-gutter").innerText();
if (!gutter.startsWith("1\n2\n3") || !gutter.trim().endsWith("60")) fail(`gutter: ${gutter.slice(0, 20)}…${gutter.slice(-10)}`);
await shot(p, "desktop-text");
ok("desktop: src/app.ts with line numbers 1–60");
await pane(p).getByRole("button", { name: "Back to files" }).click();
await row(p, "trojan.ts").locator(".t-files-item").click();
await pane(p).locator(".t-files-odd", { hasText: "bidirectional controls" }).waitFor();
ok("desktop: a file with bidi controls says so");
await pane(p).getByRole("button", { name: "Back to files" }).click();

// Markdown: preview, raw.
await row(p, "README.md").locator(".t-files-item").click();
await pane(p).locator(".t-files-md h1", { hasText: "Files demo" }).waitFor();
await shot(p, "desktop-md-preview");
await pane(p).getByRole("button", { name: "Raw" }).click();
if (!(await pane(p).locator(".t-files-text").innerText()).startsWith("# Files demo")) fail("raw markdown");
const hashBefore = await p.evaluate(() => location.hash);
await pane(p).getByRole("button", { name: "Preview" }).click();
await pane(p).locator(".t-files-md a", { hasText: "the app" }).click();
await pane(p).locator(".t-files-path", { hasText: "app.ts" }).waitFor();
if ((await p.evaluate(() => location.hash)) !== hashBefore) fail("a relative link navigated the app");
await pane(p).getByRole("button", { name: "Back to files" }).click();
await row(p, "README.md").locator(".t-files-item").click();
await pane(p).locator(".t-files-md a", { hasText: "escape" }).click();
await pane(p).locator(".t-changes-note.error", { hasText: "outside the session's folder" }).waitFor();
if (!(await pane(p).locator(".t-files-md h1").isVisible())) fail("the out-of-folder note replaced the preview");
if ((await p.evaluate(() => location.hash)) !== hashBefore) fail("an escaping link navigated the app");
// #anchor scrolls the preview only.
const pageScroll = await p.evaluate(() => document.scrollingElement.scrollTop);
await pane(p).locator(".t-files-md a", { hasText: "the end" }).click();
await p.waitForFunction(() => document.querySelectorAll(".t-files-body")[0].scrollTop > 100);
if ((await p.evaluate(() => document.scrollingElement.scrollTop)) !== pageScroll) fail("the anchor scrolled the page");
if ((await p.evaluate(() => location.hash)) !== hashBefore) fail("an anchor navigated the app");
// A folder link opens the folder in the tree.
await pane(p).locator(".t-files-md a", { hasText: "the sources" }).click();
await p.waitForFunction(() => document.activeElement?.getAttribute("data-path") === "src");
if ((await row(p, "src").getAttribute("aria-expanded")) !== "true") fail("the folder link should open src");
await row(p, "README.md").locator(".t-files-item").click();
await pane(p).getByRole("button", { name: "Raw" }).click();
ok("desktop: README.md preview (h1), raw; a relative link opens src/app.ts here, a folder link opens src in the tree, #the-end scrolls the preview only, a link out of the folder is said inline");

// Mention.
await pane(p).getByRole("button", { name: "Mention" }).click();
await pane(p).getByRole("button", { name: "In the message box" }).waitFor();
let draft = await composer(p).inputValue();
if (draft !== "@README.md ") fail(`composer after Mention: ${JSON.stringify(draft)}`);
ok(`desktop: Mention put ${JSON.stringify(draft)} in the box`);
await pane(p).getByRole("button", { name: "Back to files" }).click();

// Images: PNG, and SVG as an <img> (its script never runs).
for (const name of ["logo.png", "pic.svg"]) {
  await row(p, name).locator(".t-files-item").click();
  const img = pane(p).locator(".t-files-image img");
  await img.waitFor();
  await p.waitForFunction(() => document.querySelector(".t-files-image img")?.naturalWidth > 0);
  const src = await img.getAttribute("src");
  if (!src.startsWith(name.endsWith(".svg") ? "data:image/svg+xml;base64," : "data:image/png;base64,")) fail(`img src ${src.slice(0, 30)}`);
  await shot(p, `desktop-${name}`);
  await pane(p).getByRole("button", { name: "Back to files" }).click();
}
if (await p.locator(".t-filesview circle").count()) fail("svg inlined");
ok("desktop: logo.png and pic.svg as <img> from data URLs");

// Binary, too big (then its first 1 MB).
await row(p, "blob.bin").locator(".t-files-item").click();
await pane(p).locator(".t-changes-note", { hasText: "Binary, 8 bytes." }).waitFor();
await pane(p).getByRole("button", { name: "Back to files" }).click();
await row(p, "big.txt").locator(".t-files-item").click();
await pane(p).locator(".t-changes-note", { hasText: "too big to show here" }).waitFor();
await shot(p, "desktop-big");
await pane(p).getByRole("button", { name: "Show the first 1.0 MB" }).click();
await pane(p).locator(".t-changes-note", { hasText: "The first 1.0 MB of 1.6 MB." }).waitFor();
await pane(p).locator(".t-files-text").waitFor();
ok("desktop: blob.bin binary; big.txt too big, then its first 1 MB");
await pane(p).getByRole("button", { name: "Back to files" }).click();

// The filter.
await pane(p).getByLabel("Filter by name").fill("app");
await pane(p).locator('[aria-label="Matching files"] .t-files-item').first().waitFor();
const found = await pane(p).locator('[aria-label="Matching files"] .t-files-name').allInnerTexts();
if (found[0] !== "src/app.ts") fail(`filter: ${found}`);
await pane(p).locator('[aria-label="Matching files"] .t-files-item').first().click();
await pane(p).locator(".t-files-path", { hasText: "app.ts" }).waitFor();
await shot(p, "desktop-filter-open");
await pane(p).getByRole("button", { name: "Back to files" }).click();
await pane(p).getByLabel("Filter by name").fill("cache");
await pane(p).locator(".t-changes-note", { hasText: "No files match." }).waitFor();
await pane(p).getByLabel("Filter by name").fill("");
ok(`desktop: filter "app" → ${found.join(", ")}; ignored files never match`);

// Only inside: straight at the runner.
for (const bad of ["../outside-secret.txt", "out-link", REPO + "/README.md", "src/../../outside-secret.txt"]) {
  const x = await rpcVia(p, "readFile", { sessionId, path: bad });
  if (!x.error) fail(`readFile ${bad} answered`);
}
ok("desktop: readFile refuses ../, a link out, an absolute path");

// The tab is kept: a reload opens Files.
await p.reload();
await p.getByRole("button", { name: "Changes", exact: true }).click();
await row(p, "README.md").waitFor({ timeout: 20_000 });
ok("desktop: the Files tab is kept across a reload");

// ---------- phone ----------
const q = await page(phone, url);
await q.getByRole("button", { name: "Changes", exact: true }).click();
await pane(q).getByRole("tab", { name: "Files" }).click();
await row(q, "README.md").waitFor({ timeout: 20_000 });
const box = await pane(q).boundingBox();
if (!box || box.width < 370) fail(`phone pane not full width: ${JSON.stringify(box)}`);
await shot(q, "phone-tree");
// Mention from a row: @ is always there on a touch screen; the pane stays.
await row(q, "logo.png").locator(".t-files-at").tap();
await row(q, "logo.png").locator(".t-files-at", { hasText: "✓" }).waitFor();
await row(q, "src").locator(".t-files-item").tap();
await row(q, "app.ts").locator(".t-files-item").tap();
await pane(q).locator(".t-files-text").waitFor();
await shot(q, "phone-text");
const scroll = await pane(q).locator(".t-files-body").first().evaluate((e) => {
  const out = [e.scrollWidth, e.clientWidth];
  for (let x = e; x && x.tagName !== "BODY"; x = x.parentElement) out.push(`${x.className.split(" ")[0]}:${x.clientWidth}`);
  return out;
});
if (!(scroll[0] > scroll[1])) fail(`long lines should scroll sideways: ${scroll}`);
await pane(q).getByRole("button", { name: "Back to files" }).tap();
await row(q, "README.md").locator(".t-files-item").tap();
await pane(q).locator(".t-files-md h1").waitFor();
await shot(q, "phone-md");
await pane(q).getByRole("button", { name: "Close changes" }).tap();
draft = await composer(q).inputValue();
if (!draft.includes("@logo.png")) fail(`phone composer: ${JSON.stringify(draft)}`);
ok(`phone: full-width pane, tree, text scrolls sideways, markdown; @ on a row put ${JSON.stringify(draft)} in the box`);

if (dialogs.length) fail(`dialogs: ${dialogs}`);
if (errors.length) fail(`page errors: ${errors.join("\n")}`);
await rpcVia(p, "deleteSession", { sessionId }).catch(() => {});
await browser.close();
console.log(`all ok; screenshots in ${SHOTS}; repo ${REPO}`);
