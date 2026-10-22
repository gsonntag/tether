// fallback.ts: the strict trigger rule's building blocks (limit signals, which accounts can be
// checked, what a usage report confirms, where "Continue on …" goes).

import { resetHome } from "./testenv";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { switchesAutomatically } from "../../web/src/shared/protocol";
import { config } from "./config";
import { accountOf, agyQuota, classify, limitReached, nextEntry, providerOf, stableQuotaReset } from "./fallback";

beforeEach(() => {
  resetHome();
  config().exhausted = {};
});

describe("classify", () => {
  test("limit-looking text is only a possible limit; billing alone isn't one", () => {
    expect(classify("Claude AI usage limit reached")).toEqual({ kind: "quota", resetAt: undefined });
    expect(classify("Your request failed: billing error")).toEqual({ kind: "other" });
    expect(classify("overloaded_error", 529).kind).toBe("rate_limit");
    expect(classify("x", 429).kind).toBe("rate_limit");
    expect(classify("x").definite).toBeUndefined();
  });
});

describe("stable quota reset", () => {
  test("past and imminent resets use the one-hour cooldown", () => {
    const now = Date.now();
    expect(stableQuotaReset(now - 1, now)).toBe(now + 60 * 60_000);
    expect(stableQuotaReset(now + 30_000, now)).toBe(now + 60 * 60_000);
    expect(stableQuotaReset(now + 5 * 60_000, now)).toBe(now + 5 * 60_000);
  });
});

describe("agyQuota", () => {
  test("Antigravity's own quota message is definite, with its reset", () => {
    const now = Date.parse("2026-10-10T08:32:17Z");
    const text = "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 13h10m12s.";
    expect(agyQuota(text, now)).toEqual({ kind: "quota", definite: true, resetAt: now + (13 * 3600 + 10 * 60 + 12) * 1000 });
  });
  test("anything else is not", () => {
    expect(agyQuota("RESOURCE_EXHAUSTED (code 429): Overloaded prefill queue")).toBeUndefined();
    expect(agyQuota("Individual quota reached.")).toBeUndefined(); // not the exact shape: no reset
    expect(agyQuota(undefined)).toBeUndefined();
  });
});

describe("accountOf", () => {
  test("maps chain entries to the logins Tether can read", () => {
    expect(accountOf({ harness: "claude-code", model: "opus" })).toBe("claude");
    expect(accountOf({ harness: "codex", model: "gpt-5.5" })).toBe("chatgpt:codex");
    expect(accountOf({ harness: "pi", model: "openai-codex/gpt-5.5" })).toBe("chatgpt:pi");
    expect(accountOf({ harness: "pi", model: "anthropic/claude-opus-5-5" })).toBeUndefined();
    expect(accountOf({ harness: "opencode", model: "openai/gpt-5.5" })).toBeUndefined();
    expect(accountOf({ harness: "kiro", model: "auto" })).toBeUndefined();
    expect(accountOf({ harness: "antigravity", model: "gemini-3-pro" })).toBeUndefined();
  });
  test("what the chain editor labels as switching automatically", () => {
    expect(switchesAutomatically("claude-code", "opus")).toBe(true);
    expect(switchesAutomatically("codex", "gpt-5.5")).toBe(true);
    expect(switchesAutomatically("antigravity", "gemini-3-pro")).toBe(true); // its quota error is definite
    expect(switchesAutomatically("pi", "openai-codex/gpt-5.5")).toBe(true);
    expect(switchesAutomatically("pi", "anthropic/claude-opus-5-5")).toBe(false);
    expect(switchesAutomatically("kiro", "auto")).toBe(false);
    // Codex routed to another provider: not the ChatGPT login, so manual only.
    expect(switchesAutomatically("codex", "openai/gpt-5.5")).toBe(true);
    expect(switchesAutomatically("codex", "openrouter/qwen3-coder")).toBe(false);
    expect(accountOf({ harness: "codex", model: "openrouter/qwen3-coder" })).toBeUndefined();
    expect(accountOf({ harness: "codex", model: "gpt-5.5" })).toBe("chatgpt:codex");
    expect(providerOf("openrouter/qwen3-coder", "codex")).toBe("codex:openrouter");
    expect(providerOf("openai/gpt-5.5", "codex")).toBe("codex");
    expect(switchesAutomatically("opencode", "openai/gpt-5.5")).toBe(false);
  });
});

describe("limitReached", () => {
  const later = Date.now() + 60 * 60_000;
  const latest = Date.now() + 5 * 24 * 60 * 60_000;
  test("a window at 100% confirms it; the reset is the latest full window's", () => {
    expect(
      limitReached({
        provider: "claude",
        label: "Claude",
        windows: [
          { label: "5h", percent: 100, resetsAt: later },
          { label: "Weekly", percent: 100, resetsAt: latest },
        ],
      }),
    ).toEqual({ resetAt: latest });
  });
  test("below 100%, an error, or nothing: not confirmed", () => {
    expect(limitReached({ provider: "claude", label: "Claude", windows: [{ label: "5h", percent: 99 }] })).toBeUndefined();
    expect(limitReached({ provider: "claude", label: "Claude", windows: [{ label: "5h", percent: 100 }], error: "x" })).toBeUndefined();
    expect(limitReached(undefined)).toBeUndefined();
  });
  test("ChatGPT's limit_reached confirms it on its own", () => {
    expect(limitReached({ provider: "codex", label: "Codex", windows: [{ label: "5h", percent: 80 }], limited: true })).toEqual({ resetAt: undefined });
  });
  test("a model-scoped weekly window applies to that model only", () => {
    const u = { provider: "claude" as const, label: "Claude", windows: [{ label: "Weekly · Opus 5.5", percent: 100, resetsAt: later }] };
    expect(limitReached(u, "claude-opus-5-5")).toEqual({ resetAt: later });
    expect(limitReached(u, "opus")).toEqual({ resetAt: later });
    expect(limitReached(u, "sonnet")).toBeUndefined();
  });
});

describe("nextEntry", () => {
  test("the first entry after the current one that isn't exhausted", () => {
    const chain = ["opus", "codex:gpt-5.5", "sonnet"];
    expect(nextEntry(chain, { harness: "claude-code", model: "opus" }, "claude-code")).toEqual({ harness: "codex", model: "gpt-5.5" });
    config().exhausted["codex"] = Date.now() + 60_000;
    expect(nextEntry(chain, { harness: "claude-code", model: "opus" }, "claude-code")).toEqual({ harness: "claude-code", model: "sonnet" });
    expect(nextEntry(chain, { harness: "claude-code", model: "sonnet" }, "claude-code")).toBeUndefined();
    // Not in the chain: from the top.
    expect(nextEntry(chain, { harness: "claude-code", model: "haiku" }, "claude-code")).toEqual({ harness: "claude-code", model: "opus" });
  });
});

describe("tests can't reach the real home", () => {
  test("no runner module but home.ts calls os.homedir() (Bun ignores a HOME set at runtime there)", () => {
    const root = join(import.meta.dir);
    const files = [...new Bun.Glob("**/*.ts").scanSync(root)].filter((f) => !f.endsWith(".test.ts") && f !== "home.ts");
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) expect([f, /\bhomedir\s*\(/.test(readFileSync(join(root, f), "utf8"))]).toEqual([f, false]);
  });
});
