// Antigravity returns aggregate usage for a prompt. Keep only the metadata needed by Settings → Usage.
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "../../credentials";

export const agyUsageDir = join(DATA_DIR, "antigravity-usage");

export async function recordAgyUsage(
  dir: string,
  turn: { session: string; project: string; model?: string; plan: boolean },
  usage: unknown,
) {
  if (!usage || typeof usage !== "object") return;
  const counts = usage as Record<string, unknown>;
  const count = (key: string) => {
    const value = counts[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
  };
  const input = count("inputTokens");
  const output = count("outputTokens") + count("thoughtTokens");
  const read = count("cachedReadTokens");
  const write = count("cachedWriteTokens");
  if (!input && !output && !read && !write) return;

  const file = createHash("sha256").update(JSON.stringify([turn.session, turn.project])).digest("hex");
  const entry = { type: "agy_turn_usage", id: randomUUID(), timestamp: new Date().toISOString(), ...turn, input, output, read, write };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await appendFile(join(dir, `${file}.jsonl`), JSON.stringify(entry) + "\n", { mode: 0o600 });
}
