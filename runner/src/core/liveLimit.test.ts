// TETHER_MAX_LIVE_SESSIONS: on a shared host a runner keeps at most this many sessions live.

import { afterEach, describe, expect, test } from "bun:test";
import { RequestBroker } from "./broker";
import { EventBus } from "./bus";
import type { CoreEvents } from "./events";
import { FakeAdapter } from "./fakeAdapter";
import { LiveControl } from "./live";
import { Prefs } from "./prefs";
import { SessionCore } from "./sessions";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function setup(maxLive?: number) {
  const adapter = new FakeAdapter();
  for (const id of ["one", "two", "three"]) adapter.addStored(id, []);
  adapter.addStored("home", [], { projectPath: "/home/t/.config/tether/modules/homeAgent/workspace/chat-1" });
  adapter.addStored("child", [], { parentSessionId: "claude:one" });
  const core = new SessionCore({ adapters: [adapter], bus: new EventBus<CoreEvents>(), send: () => true, prefs: new Prefs("/nonexistent/tether-limit-test/runner.json", 60_000), epoch: "limit", log: () => {} });
  const live = new LiveControl(core, new RequestBroker(), { idleMs: 60_000, maxLive, homeFolder: "/home/t/.config/tether/modules/homeAgent/workspace" });
  cleanups.push(() => core.stop());
  return { core, live, adapter };
}

describe("live-session limit", () => {
  test("refuses one more live session with a clear error, and allows it once one closes", async () => {
    const { core, live, adapter } = setup(2);
    await core.discover();
    await live.send("claude:one", "hi");
    await live.send("claude:two", "hi");
    await expect(live.send("claude:three", "hi")).rejects.toThrow(/2 live sessions, its limit \(TETHER_MAX_LIVE_SESSIONS=2\)/);
    expect(adapter.drivers).toHaveLength(2);
    // a session already live is never refused
    await live.send("claude:one", "again");
    // the Home agent's chats and subagents don't count and aren't refused
    await live.send("claude:home", "hi");
    expect(adapter.drivers).toHaveLength(3);
  });

  test("no limit by default", async () => {
    const { core, live, adapter } = setup();
    await core.discover();
    for (const id of ["one", "two", "three"]) await live.send(`claude:${id}`, "hi");
    expect(adapter.drivers).toHaveLength(3);
  });
});
