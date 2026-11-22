// A one-shot side query (Adapter.ask): a commit message or a PR's title and body, asked of Claude Code
// on the session's own source. Haiku, no tools, none of the person's settings, hooks or CLAUDE.md, no
// MCP servers at all (strictMcpConfig with none), a short system prompt, one turn, nothing saved
// (`persistSession: false`): no transcript gets it and no session is made. The source is confirmed as
// a session's start confirms it, before the prompt goes out (the input waits for it); a key goes
// through its private helper, never the environment. On a key a budget caps what one answer may cost,
// and what it cost is reported (`onCost`) for the session's API ledger. One deadline covers it all:
// starting, confirming and answering.

import { query as sdkQuery, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionCost } from "../../../../shared/costs";
import type { CredentialSnapshot } from "../../credentials";
import { redact } from "../../credentials";
import { CLAUDE_BIN } from "./bin";
import { claudeAuthSettings, claudeEnv, claudeKeyLease, confirmClaudeBilling } from "./credentials";

/** The small model a side query runs on. */
export const ASK_MODEL = "haiku";
/** What one answer may cost on a key (USD). */
export const ASK_BUDGET_USD = 0.05;

export interface AskOpts {
  credential?: CredentialSnapshot;
  system: string;
  timeoutMs: number;
  /** what it cost on a key (once, when the prompt went out) */
  onCost?: (c: SessionCost) => void;
}

/** What the query needs (tests give a fake SDK and lease). */
export interface AskDeps {
  query: typeof sdkQuery;
  lease: typeof claudeKeyLease;
  bin?: string;
}

export function claudeAsk(projectPath: string, prompt: string, opts: AskOpts): Promise<string> {
  return askWith({ query: sdkQuery, lease: claudeKeyLease, bin: CLAUDE_BIN }, projectPath, prompt, opts);
}

export async function askWith(deps: AskDeps, projectPath: string, prompt: string, opts: AskOpts): Promise<string> {
  if (!deps.bin) throw new Error("Claude Code isn't installed.");
  const onBedrock = opts.credential?.source === "bedrock";
  const onKey = opts.credential?.source === "anthropic";
  const lease = deps.lease(opts.credential);
  let go!: (ok: boolean) => void;
  const confirmed = new Promise<boolean>((r) => (go = r));
  let sent = false;
  let reported = false;
  async function* input(): AsyncGenerator<SDKUserMessage> {
    if (!(await confirmed)) return;
    sent = true;
    yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, session_id: "" } as SDKUserMessage;
  }
  const q = deps.query({
    prompt: input(),
    options: {
      cwd: projectPath,
      model: onBedrock ? opts.credential?.deployment : ASK_MODEL,
      persistSession: false,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      maxTurns: 1,
      ...(onKey ? { maxBudgetUsd: ASK_BUDGET_USD } : {}),
      settingSources: [],
      settings: claudeAuthSettings(lease.helper),
      systemPrompt: opts.system,
      env: { ...claudeEnv(opts.credential), ...lease.env },
      pathToClaudeCodeExecutable: deps.bin,
    } as any,
  });
  const close = () => {
    go(false);
    try {
      q.close();
    } catch {}
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      close();
      reject(new Error("Claude Code didn't answer in time."));
    }, opts.timeoutMs);
  });
  void late.catch(() => {});
  const run = async (): Promise<string> => {
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
      if (onKey && opts.onCost) {
        reported = true;
        const usd = typeof m.total_cost_usd === "number" && Number.isFinite(m.total_cost_usd) && m.total_cost_usd >= 0 ? m.total_cost_usd : undefined;
        opts.onCost(usd === undefined ? { estimated: true, complete: false, reasons: ["no-usage"] } : { usd, estimated: true, complete: true });
      }
      if (m.subtype === "success" && !m.is_error && typeof m.result === "string") return m.result;
      throw new Error("Claude Code didn't answer.");
    }
    throw new Error("Claude Code didn't answer.");
  };
  const running = run();
  void running.catch(() => {});
  try {
    return await Promise.race([running, late]);
  } catch (e) {
    throw new Error(redact((e as Error).message || String(e)));
  } finally {
    clearTimeout(timer);
    close();
    if (onBedrock && sent) opts.onCost?.(lease.cost?.() ?? { estimated: true, complete: false, reasons: ["no-usage"] });
    await lease.close();
    // The prompt went out but no result said what it cost: the session's total can't be whole.
    if (onKey && opts.onCost && sent && !reported) opts.onCost({ estimated: true, complete: false, reasons: ["no-usage"] });
  }
}
