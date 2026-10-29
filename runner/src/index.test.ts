import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function start(env: Record<string, string>) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("TETHER_")));
  return Bun.spawn(["bun", "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...clean, TETHER_CONFIG_DIR: mkdtempSync(join(tmpdir(), "tether-idx-")), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("refuses to start without TETHER_URL and TETHER_TOKEN, naming what's missing", async () => {
  const p = start({});
  expect(await p.exited).toBe(1);
  expect(await new Response(p.stderr).text()).toContain("Set TETHER_URL and TETHER_TOKEN");
  const q = start({ TETHER_URL: "http://127.0.0.1:1" });
  expect(await q.exited).toBe(1);
  expect(await new Response(q.stderr).text()).toContain("Set TETHER_TOKEN");
});

test("TETHER_DEV=1 falls back to the local dev server", async () => {
  const p = start({ TETHER_DEV: "1", TETHER_URL: "http://127.0.0.1:1" });
  // It starts and keeps retrying; read until it says where it dials, then stop it.
  const reader = p.stdout.getReader();
  let out = "";
  const t0 = Date.now();
  while (!out.includes("Tether runner") && Date.now() - t0 < 10_000) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  p.kill();
  expect(out).toContain("Tether runner");
}, 15_000);
