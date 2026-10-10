// ACP activity (opencode, Kiro). ACP only has tool cards: a subagent shows up as a `task` tool call
// (rawInput { description, prompt, subagent_type }), with its model in rawOutput.metadata once it
// ends. Its own steps aren't sent, and a background task's later progress isn't either.

import type { ActivityItem } from "../../../web/src/shared/protocol";
import { ActivityBook } from "./activity";

const isTask = (u: any) => !!u?.rawInput && typeof u.rawInput === "object" && "subagent_type" in u.rawInput;

export class AcpActivity extends ActivityBook {
  /** Feeds one session/update (tool_call or tool_call_update); returns the items that changed. */
  onUpdate(u: any): ActivityItem[] {
    if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") {
      const id = u.toolCallId;
      if (!this.get(id) && isTask(u) && u.status !== "completed" && u.status !== "failed") {
        const i = u.rawInput;
        this.put({
          id,
          kind: "subagent",
          title: i.description || u.title || "Subagent",
          description: i.prompt,
          agentType: i.subagent_type,
          status: "running",
          startedAt: this.now(),
          toolId: id,
          background: !!i.background,
        });
      }
      if (this.get(id) && (u.status === "completed" || u.status === "failed")) {
        const out = u.rawOutput && typeof u.rawOutput === "object" ? u.rawOutput : {};
        const meta = out.metadata ?? {};
        const summary = typeof out.output === "string" ? out.output : typeof out.error === "string" ? out.error : undefined;
        // A background task's call ends at launch: it keeps going where ACP can't see.
        const m = typeof meta.model === "string" ? meta.model : meta.model?.modelID ? [meta.model.providerID, meta.model.modelID].filter(Boolean).join("/") : undefined;
        const model = m ? { model: m } : {};
        if (meta.background || meta.jobId) this.end(id, "done", { summary: "Started in the background; its progress isn't reported over ACP.", ...model });
        else this.end(id, u.status === "failed" ? "failed" : "done", { summary, ...model });
      }
    }
    return this.take();
  }
}
