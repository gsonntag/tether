// A one-shot side query (Adapter.ask): a commit message or a PR's title and body, asked of Codex. Only
// on the ChatGPT plan, through the shared daemon: an ephemeral thread (no rollout, never listed),
// read-only, never asking, on the account's smallest model, with Codex's shell, patch, web, apps and subagent tools off, low effort,
// and the subscription's authentication path confirmed as a session's start confirms it before the
// prompt goes out. A key session gets no generated text: a side query there would need a private
// app-server of its own started and confirmed for one answer.

import type { CredentialSnapshot } from "../../credentials";
import { confirmSubscriptionProvider } from "./billing";
import { connect } from "./daemon";
import { AGENT_CONFIG } from "./setup";

export async function codexAsk(projectPath: string, prompt: string, opts: { credential?: CredentialSnapshot; system: string; timeoutMs: number }): Promise<string> {
  if (opts.credential && opts.credential.source !== "subscription") throw new Error("Generating text isn't available for Codex sessions on an API key.");
  const rpc = await connect("tether-ask");
  const deadline = Date.now() + opts.timeoutMs;
  const left = () => Math.max(1000, deadline - Date.now());
  try {
    // The smallest model the account offers (a mini), else its default: the config's own may be one the plan refuses.
    const models: any[] = (await rpc.call<any>("model/list", {}, left()).catch(() => undefined))?.data ?? [];
    const pick = models.find((m) => !m.hidden && /mini|nano/i.test(String(m.id))) ?? models.find((m) => m.isDefault) ?? models[0];
    const started: any = await rpc.call(
      "thread/start",
      { cwd: projectPath, ephemeral: true, ...(pick?.id ? { model: String(pick.id) } : {}), sandbox: "read-only", approvalPolicy: "never", developerInstructions: opts.system, config: AGENT_CONFIG },
      left(),
    );
    const threadId: string = started.thread.id;
    const account = await rpc.call("account/read", { refreshToken: false }, Math.min(10_000, left())).then((a: any) => a?.account, () => undefined);
    const cfg: any = await rpc.call("config/read", { cwd: projectPath }, left());
    confirmSubscriptionProvider(started.modelProvider ?? started.thread?.modelProvider, account, cfg?.config);
    let text = "";
    const done = new Promise<string>((resolve, reject) => {
      const off = rpc.onNotify((method, p) => {
        if (p?.threadId !== threadId) return;
        if (method === "item/completed" && p.item?.type === "agentMessage" && typeof p.item.text === "string") text = p.item.text;
        if (method === "turn/completed") {
          off();
          if (p.turn?.status === "failed") reject(new Error(String(p.turn?.error?.message ?? "Codex didn't answer.")));
          else resolve(text);
        }
      });
      rpc.onClose(() => reject(new Error("Codex closed the connection.")));
      setTimeout(() => reject(new Error("Codex didn't answer in time.")), left());
    });
    void done.catch(() => {});
    await rpc.call("turn/start", { threadId, input: [{ type: "text", text: prompt, text_elements: [] }], effort: "low" }, left());
    const out = await done;
    if (!out.trim()) throw new Error("Codex didn't answer.");
    return out;
  } finally {
    rpc.close();
  }
}
