import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// The pickers reach the app's connection module, which reads the page's address when loaded.
(globalThis as any).location ??= { protocol: "http:", host: "localhost" };
(globalThis as any).document ??= { addEventListener() {}, visibilityState: "visible" };
(globalThis as any).window ??= { addEventListener() {} };
(globalThis as any).requestAnimationFrame ??= () => 0;
const { HomeAgentPickers, nextSettings } = await import("./HomeAgentSettings");

test("a pick changes just that; another agent starts on its own source, its default model and auto", () => {
  const s = { harness: "claude" as const, source: "subscription" as const, model: "opus", mode: "auto" };
  expect(nextSettings(s, { mode: "bypassPermissions" })).toEqual({ ...s, mode: "bypassPermissions" });
  expect(nextSettings(s, { model: "haiku" })).toEqual({ ...s, model: "haiku" });
  // Another source drops the model (Azure's are deployments; the runner picks).
  expect(nextSettings(s, { source: "azure" })).toEqual({ harness: "claude", source: "azure", mode: "auto" });
  expect(nextSettings({ ...s, mode: "plan" }, { harness: "codex" }, "openai")).toEqual({ harness: "codex", source: "openai", mode: "auto" });
  expect(nextSettings(s, { harness: "codex" })).toEqual({ harness: "codex", source: "subscription", mode: "auto" });
});

test("the Home agent's settings are the session page's chips: Model and Mode, Auto by default; Agent only with a choice", () => {
  const props = { runnerId: "r", settings: { harness: "claude" as const, source: "subscription" as const }, onChanged: () => {}, onError: () => {} };
  const one = renderToStaticMarkup(<HomeAgentPickers {...props} harnesses={["claude"]} />);
  expect(one).toContain('aria-label="Model: ');
  expect(one).toContain('aria-label="Mode: Auto"');
  expect(one).toContain('class="t-chip"');
  expect(one).not.toContain("Agent: ");
  const two = renderToStaticMarkup(<HomeAgentPickers {...props} harnesses={["claude", "codex"]} />);
  expect(two).toContain('aria-label="Agent: Claude Code"');
});
