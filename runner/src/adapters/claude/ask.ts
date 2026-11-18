// A one-shot side query (Adapter.ask): a commit message or a PR's title and body, asked of Claude Code
// on the session's own source. Haiku, no tools, none of the person's settings, hooks, MCP servers or
// CLAUDE.md, a short system prompt, one turn, nothing saved (`persistSession: false`): no transcript
// gets it and no session is made. The source is confirmed as a session's start confirms it, before
// the prompt goes out (the input waits for it); a key goes through its private helper, never the
// environment. On a key a budget caps what one answer may cost.

import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CredentialSnapshot } from "../../credentials";
import { redact } from "../../credentials";
import { CLAUDE_BIN } from "./bin";
import { claudeAuthSettings, claudeEnv, claudeKeyLease, confirmClaudeBilling } from "./credentials";

/** The small model a side query runs on. */
export const ASK_MODEL = "haiku";
/** What one answer may cost on a key (USD). */
const ASK_BUDGET_USD = 0.05;

export async function claudeAsk(projectPath: string, prompt: string, opts: { credential?: CredentialSnapshot; system: string; timeoutMs: number }): Promise<string> {
  if (!CLAUDE_BIN) throw new Error("Claude Code isn't installed.");
  const lease = claudeKeyLease(opts.credential);
  let go!: (ok: boolean) => void;
  const confirmed = new Promise<boolean>((r) => (go = r));
  async function* input(): AsyncGenerator<SDKUserMessage> {
    if (!(await confirmed)) return;
    yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, session_id: "" } as SDKUserMessage;
  }
  const q = query({
    prompt: input(),
    options: {
      cwd: projectPath,
      model: ASK_MODEL,
      persistSession: false,
      tools: [],
      maxTurns: 1,
      ...(opts.credential?.source === "anthropic" ? { maxBudgetUsd: ASK_BUDGET_USD } : {}),
      settingSources: [],
      settings: claudeAuthSettings(lease.helper),
      systemPrompt: opts.system,
      env: claudeEnv(opts.credential),
      pathToClaudeCodeExecutable: CLAUDE_BIN,
    } as any,
  });
  const timer = setTimeout(() => {
    go(false);
    try {
      q.close();
    } catch {}
  }, opts.timeoutMs);
  try {
    // Nothing is sent until Claude Code says what it draws from, and it's the session's source.
    await q.initializationResult();
    try {
      confirmClaudeBilling(await q.accountInfo().catch(() => undefined), opts.credential);
    } catch (e) {
      go(false);
      throw e;
    }
    go(true);
    for await (const m of q) {
      if (m.type !== "result") continue;
      if (m.subtype === "success" && !m.is_error && typeof m.result === "string") return m.result;
      throw new Error("Claude Code didn't answer.");
    }
    throw new Error("Claude Code didn't answer in time.");
  } catch (e) {
    throw new Error(redact((e as Error).message || String(e)));
  } finally {
    clearTimeout(timer);
    go(false);
    try {
      q.close();
    } catch {}
    lease.close();
  }
}
