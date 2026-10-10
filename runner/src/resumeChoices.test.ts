// A resumed session comes back on the model, effort and mode it last ran with.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TETHER_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tether-resume-choices-"));
const { LiveSession } = await import("./session");
const { config, prefs } = await import("./config");

const sink = { emit: () => {}, summary: () => {}, handoff: async () => {} };
const sessions: InstanceType<typeof LiveSession>[] = [];

/** A harness that starts on its defaults, like a resumed Claude process. */
function fake(nativeId = crypto.randomUUID()) {
  const log: string[] = [];
  class Fake extends LiveSession {
    async start() {
      this.setState({ status: "idle", model: "default", thinking: "high", thinkingLevels: ["low", "medium", "high"], modes: ["default", "plan", "acceptEdits"], permissionMode: "default" });
    }
    protected async send() {}
    async abort() {}
    async applyModel(m: string) {
      log.push(`model ${m}`);
      this.setState({ model: m });
    }
    async setThinking(l: string) {
      log.push(`effort ${l}`);
      this.setState({ thinking: l });
    }
    async setPermissionMode(m: string) {
      log.push(`mode ${m}`);
      this.setState({ permissionMode: m });
    }
    async rename() {}
    async listCommands() {
      return [];
    }
    async continueTurn() {}
    protected shutdown() {}
  }
  const s = new Fake("claude-code", { nativeId, projectPath: "/tmp" }, sink);
  sessions.push(s);
  return { s, log };
}

afterEach(() => sessions.splice(0).forEach((s) => s.close()));

describe("resume restores the session's choices", () => {
  test("model, effort and plan mode are saved, then re-applied after a restart", async () => {
    const id = crypto.randomUUID();
    const first = fake(id);
    await first.s.start();
    first.s.loadPrefs();
    await first.s.applyModel("haiku");
    await first.s.setThinking("low");
    await first.s.setPermissionMode("plan");
    expect(prefs(first.s.id)).toMatchObject({ model: "haiku", thinking: "low", permissionMode: "plan" });
    first.s.close();

    // The runner restarts: what getLive does (read the prefs, start, load, re-apply).
    const saved = structuredClone(config().sessions[`claude-code:${id}`]);
    const again = fake(id);
    await again.s.start();
    again.s.loadPrefs(); // starting re-saves defaults over the prefs…
    expect(prefs(again.s.id).model).toBe("default");
    await again.s.reapplyChoices(saved); // …so the copy read before start is what counts
    expect(again.log).toEqual(["model haiku", "effort low", "mode plan"]);
    expect(again.s.t.state).toMatchObject({ model: "haiku", thinking: "low", permissionMode: "plan" });
    expect(prefs(again.s.id)).toMatchObject({ model: "haiku", thinking: "low", permissionMode: "plan" });
  });

  test("nothing to do when it matches; modes that approve on their own and unknown levels are skipped", async () => {
    const { s, log } = fake();
    await s.start();
    await s.reapplyChoices(undefined);
    await s.reapplyChoices({ model: "default", thinking: "high", permissionMode: "default" });
    await s.reapplyChoices({ thinking: "ultra", permissionMode: "acceptEdits" });
    await s.reapplyChoices({ permissionMode: "build" }); // not offered by this harness
    expect(log).toEqual([]);
  });
});
