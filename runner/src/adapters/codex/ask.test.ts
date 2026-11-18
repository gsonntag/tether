import { expect, test } from "bun:test";
import { codexAsk } from "./ask";

test("a Codex side query on a key is refused before anything starts", async () => {
  await expect(codexAsk("/tmp", "hi", { credential: { source: "openai", revision: "r" } as never, system: "s", timeoutMs: 1000 })).rejects.toThrow("API key");
});
