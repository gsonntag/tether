import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { StopIcon } from "@heroicons/react/24/outline";
import { effortLabel, modelLabel, permissionModeLabel } from "../../../shared/labels";
import type { LiveState, ModelList, SessionSummary } from "../../../shared/transcript";
import { rpc } from "../connection";
import { openSession } from "../route";
import type { Row } from "../sessionList";
import { loadModels } from "../store";
import { ChoiceMenu } from "./ChoiceMenu";
import { StatusDot } from "./SessionRow";

export function SessionHeader({ runnerId, session, state, models, children }: { runnerId: string; session: SessionSummary; state: LiveState; models?: ModelList; children: Row[] }) {
  const [error, setError] = useState<string>();
  const isChild = !!session.parentSessionId;
  const call = async (p: Promise<unknown>) => {
    setError(undefined);
    try {
      await p;
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const ensureModels = () => void (models ? undefined : loadModels(runnerId, session.harness, session.id));
  const current = models?.models.find((m) => m.id === state.model);
  const efforts = current?.efforts ? (models?.efforts ?? []).filter((e) => current.efforts!.includes(e.id)) : (models?.efforts ?? []);

  return (
    <div className="t-header">
      <div className="t-header-top">
        <span className="t-header-title" title={session.title}>
          {session.title || "Untitled"}
        </span>
        <StatusDot status={state.status} requests={state.requests.length} />
        {isChild && state.status === "running" && (
          <Button label="Stop" size="sm" variant="secondary" icon={<Icon icon={StopIcon} size="sm" />} onClick={() => void call(rpc(runnerId, "interrupt", { sessionId: session.id }))} />
        )}
      </div>
      <div className="t-header-sub" title={session.projectPath}>
        {isChild ? `Subagent${session.agentType ? ` · ${session.agentType}` : ""} · ${session.projectPath}` : session.projectPath}
      </div>
      <div className="t-chips">
        {isChild ? (
          <button type="button" className="t-chip" onClick={() => openSession(runnerId, session.parentSessionId!)}>
            ← Main session
          </button>
        ) : (
          <>
            <ChoiceMenu
              name="Model"
              value={state.model}
              label={modelLabel(state.model, models?.models, state.modelResolved)}
              choices={(models?.models ?? []).map((m) => ({ id: m.id, label: m.label, description: m.description }))}
              onOpen={ensureModels}
              onPick={(model) => void call(rpc(runnerId, "setModel", { sessionId: session.id, model }))}
            />
            {(efforts.length > 0 || state.effort) && (
              <ChoiceMenu name="Effort" value={state.effort} label={effortLabel(state.effort)} choices={efforts} onOpen={ensureModels} onPick={(effort) => void call(rpc(runnerId, "setEffort", { sessionId: session.id, effort }))} />
            )}
            <ChoiceMenu
              name="Mode"
              value={state.permissionMode}
              label={permissionModeLabel(state.permissionMode)}
              choices={models?.permissionModes ?? []}
              onOpen={ensureModels}
              onPick={(mode) => void call(rpc(runnerId, "setPermissionMode", { sessionId: session.id, mode }))}
            />
          </>
        )}
        {children.map((c) => (
          <button key={c.id} type="button" className="t-chip" title={c.title} onClick={() => openSession(runnerId, c.id)}>
            <StatusDot status={c.status} />
            <span className="t-chip-key">Subagent</span>
            <span>{c.title || c.agentType || "Untitled"}</span>
          </button>
        ))}
      </div>
      {error && <div className="t-inline-status error">{error}</div>}
    </div>
  );
}
