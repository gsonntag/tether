// A one-shot side query (Adapter.ask): a commit message or a PR's title and body, asked of Codex. Only
// on the ChatGPT plan, through the shared daemon: an ephemeral thread (no rollout, never listed),
// read-only, never asking, on the account's smallest model at low effort, with Codex's shell, patch,
// web, apps and subagent tools off, every MCP server off and no AGENTS.md read (project_doc_max_bytes
// 0), and the subscription's authentication path confirmed as a session's start confirms it before
// the prompt goes out. One deadline covers it all; past it the turn is interrupted. A key session
// gets no generated text: a side query there would need a private app-server of its own started and
// confirmed for one answer.

import type { CredentialSnapshot } from "../../credentials";
import { confirmSubscriptionProvider } from "./billing";
import { connect } from "./daemon";
import type { CodexRpc } from "./rpc";

/** A side query has no use for Codex's own shell, patch, web, apps and subagent tools: switched off by config. */
export const AGENT_CONFIG = {
  "features.shell_tool": false,
  "features.apps": false,
  "features.multi_agent": false,
  include_apply_patch_tool: false,
  web_search: "disabled",
} as const;

export async function codexAsk(projectPath: string, prompt: string, opts: { credential?: CredentialSnapshot; system: string; timeoutMs: number }, conn: () => Promise<CodexRpc> = () => connect("tether-ask")): Promise<string> {
  if (opts.credential && opts.credential.source !== "subscription") throw new Error("Generating text isn't available for Codex sessions on an API key.");
  const deadline = Date.now() + opts.timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let turn: { threadId: string; turnId?: string } | undefined;
  let rpc: CodexRpc | undefined;
  /** past the deadline (or failed): nothing more starts, and a connection that arrives late is closed */
  let aborted = false;
  const check = () => {
    if (aborted) throw new Error("Codex didn't answer in time.");
  };
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      aborted = true;
      reject(new Error("Codex didn't answer in time."));
    }, opts.timeoutMs);
  });
  void late.catch(() => {});
  const run = async (): Promise<string> => {
    const r = await conn();
    rpc = r;
    if (aborted) {
      r.close();
      check();
    }
    // The smallest model the account offers (a mini), else its default: the config's own may be one the plan refuses.
    const models: any[] = (await r.call<any>("model/list", {}, left()).catch(() => undefined))?.data ?? [];
    const pick = models.find((m) => !m.hidden && /mini|nano/i.test(String(m.id))) ?? models.find((m) => m.isDefault) ?? models[0];
    check();
    const cfg: any = await r.call("config/read", { cwd: projectPath }, left());
    check();
    const mcpOff = Object.fromEntries(Object.keys(cfg?.config?.mcp_servers ?? {}).map((name) => [`mcp_servers.${name}.enabled`, false]));
    const started: any = await r.call(
      "thread/start",
      {
        cwd: projectPath,
        ephemeral: true,
        ...(pick?.id ? { model: String(pick.id) } : {}),
        sandbox: "read-only",
        approvalPolicy: "never",
        developerInstructions: opts.system,
        config: { ...AGENT_CONFIG, ...mcpOff, project_doc_max_bytes: 0 },
      },
      left(),
    );
    const threadId: string = started.thread.id;
    check();
    const account = await r.call("account/read", { refreshToken: false }, Math.min(10_000, left())).then((a: any) => a?.account, () => undefined);
    confirmSubscriptionProvider(started.modelProvider ?? started.thread?.modelProvider, account, cfg?.config);
    check();
    let text = "";
    const done = new Promise<string>((resolve, reject) => {
      const off = r.onNotify((method, p) => {
        if (p?.threadId !== threadId) return;
        if (method === "item/completed" && p.item?.type === "agentMessage" && typeof p.item.text === "string") text = p.item.text;
        if (method === "turn/completed") {
          off();
          turn = undefined;
          if (p.turn?.status === "failed") reject(new Error(String(p.turn?.error?.message ?? "Codex didn't answer.")));
          else resolve(text);
        }
      });
      r.onClose(() => reject(new Error("Codex closed the connection.")));
    });
    void done.catch(() => {});
    check();
    turn = { threadId };
    const t: any = await r.call("turn/start", { threadId, input: [{ type: "text", text: prompt, text_elements: [] }], effort: "low" }, Math.max(left(), 5_000));
    if (turn) turn.turnId = t?.turn?.id;
    // The deadline passed while turn/start was on its way: the turn it started stops now.
    if (aborted) {
      await interrupt(r);
      check();
    }
    const out = await done;
    if (!out.trim()) throw new Error("Codex didn't answer.");
    return out;
  };
  const interrupt = async (r: CodexRpc) => {
    const tt = turn;
    if (!tt?.turnId) return;
    turn = undefined;
    if (!r.closed) await r.call("turn/interrupt", { threadId: tt.threadId, turnId: tt.turnId }, 5_000).catch(() => {});
  };
  const running = run().finally(() => rpc?.close());
  void running.catch(() => {});
  try {
    return await Promise.race([running, late]);
  } finally {
    aborted = true;
    clearTimeout(timer);
    // Cut short (a timeout, an error): the turn stops rather than running on unseen. One whose
    // turn/start hasn't answered yet is stopped by run() once its id arrives.
    if (rpc && !(turn && !turn.turnId)) {
      await interrupt(rpc);
      rpc.close();
    }
  }
}
