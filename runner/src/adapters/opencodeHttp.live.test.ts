// Live check of `opencode acp`'s HTTP API as Tether starts it: loopback only, and closed to
// anyone without the per-process password. Runs only with OPENCODE_BIN set (a temp HOME is used).
//   OPENCODE_BIN=/path/to/opencode bun test src/adapters/opencodeHttp.live.test.ts

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpProcess, OPENCODE_ENV } from "./acp";

const BIN = process.env.OPENCODE_BIN;
const live = BIN ? test : test.skip;

let home = "";
let saved: Record<string, string | undefined> = {};
let p: AcpProcess | undefined;

beforeAll(() => {
  if (!BIN) return;
  home = mkdtempSync(join(tmpdir(), "tether-oc-live-"));
  saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state") });
});

afterAll(async () => {
  if (!BIN) return;
  p?.proc.kill();
  await p?.exited;
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  rmSync(home, { recursive: true, force: true });
});

live(
  "opencode's API: loopback, password required, ACP still works",
  async () => {
    p = new AcpProcess({ id: "opencode", bin: BIN!, args: ["acp"], env: OPENCODE_ENV, httpPermissionReply: true }, home, { http: true });
    await p.init();
    const s = await p.conn.newSession({ cwd: home, mcpServers: [] }); // opencode's own client reaches its server
    expect(s.sessionId).toBeTruthy();
    const api = p.http!;
    expect(api.base).toStartWith("http://127.0.0.1:");
    const url = `${api.base}/permission?directory=${encodeURIComponent(home)}`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { Authorization: "Basic " + btoa("opencode:wrong") } })).status).toBe(401);
    const ok = await fetch(url, { headers: { Authorization: api.auth } });
    expect(ok.status).toBe(200);
    expect(Array.isArray(await ok.json())).toBe(true);
    // Only the loopback listener.
    const port = new URL(api.base).port;
    const listen = Bun.spawnSync(["ss", "-Hltn", `sport = :${port}`]).stdout.toString().trim().split("\n").filter(Boolean);
    expect(listen.length).toBe(1);
    expect(listen[0]).toContain(`127.0.0.1:${port}`);
  },
  60_000,
);
