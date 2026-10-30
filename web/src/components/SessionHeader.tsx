import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { StopIcon } from "@heroicons/react/24/outline";
import { effortLabel, modelLabel, permissionModeLabel } from "../../../shared/labels";
import { HARNESS_LABELS, type HarnessCapabilities, type LiveState, type ModelList, type SessionSummary } from "../../../shared/transcript";
import { rpc } from "../connection";
import { openSession } from "../route";
import type { Row } from "../sessionList";
import { loadModels } from "../store";
import { ChoiceMenu } from "./ChoiceMenu";
import { StatusDot } from "./SessionRow";
import { SubagentChips } from "./SubagentChips";

export function SessionHeader({
  runnerId,
  session,
  state,
  models,
  children,
  extra,
  capabilities,
}: {
  runnerId: string;
  session: SessionSummary;
  state: LiveState;
  models?: ModelList;
  children: Row[];
  extra?: React.ReactNode;
  capabilities?: HarnessCapabilities;
}) {
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
  // A handoff TUI drives (SPEC §8): it takes no settings from Tether.
  const locked = state.mode === "terminal" && capabilities?.terminal === "handoff" ? `${HARNESS_LABELS[session.harness]}'s terminal is driving. Change it there.` : undefined;
  // Changed during a turn on a harness where that counts from the next turn: the turn's own values.
  const turn = state.turnSettings;
  const nextTurn = (now: string, was: string | undefined) => (was !== undefined && turn?.who !== "subagent" ? `${now} from the next turn` : now);
  const modes = models?.permissionModes ?? [];
  // Tighter: earlier in the harness's list of modes (strictest first), so this turn runs looser than shown.
  const rank = (m?: string) => modes.findIndex((x) => x.id === m);
  // The harness says (by approval policy and sandbox, for any combination); else by the list's order.
  const tighter = turn?.looser ?? (turn?.permissionMode !== undefined && rank(state.permissionMode) >= 0 && rank(turn.permissionMode) > rank(state.permissionMode));
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
              // While the TUI drives, its /model is what runs: Tether shows the last it knew.
              label={locked ? `Set in the terminal (last seen: ${modelLabel(state.model, models?.models, state.modelResolved)})` : nextTurn(modelLabel(state.model, models?.models, state.modelResolved), turn?.model)}
              disabled={locked}
              choices={(models?.models ?? []).map((m) => ({ id: m.id, label: m.label, description: m.description }))}
              onOpen={ensureModels}
              onPick={(model) => void call(rpc(runnerId, "setModel", { sessionId: session.id, model }))}
            />
            {(efforts.length > 0 || state.effort) && (
              <ChoiceMenu name="Effort" value={state.effort} label={locked ? `Set in the terminal (last seen: ${effortLabel(state.effort)})` : nextTurn(effortLabel(state.effort), turn?.effort)} disabled={locked} choices={efforts} onOpen={ensureModels} onPick={(effort) => void call(rpc(runnerId, "setEffort", { sessionId: session.id, effort }))} />
            )}
            <ChoiceMenu
              name="Mode"
              value={state.permissionMode}
              // While Claude's TUI drives, its mode comes from its hooks: the last one it reported.
              label={locked ? `Set in the terminal (last seen: ${permissionModeLabel(state.permissionMode)})` : nextTurn(permissionModeLabel(state.permissionMode), turn?.permissionMode)}
              disabled={locked}
              choices={models?.permissionModes ?? []}
              onOpen={ensureModels}
              onPick={(mode) => void call(rpc(runnerId, "setPermissionMode", { sessionId: session.id, mode }))}
            />
          </>
        )}
        <SubagentChips runnerId={runnerId} children={children} />
      </div>
      {/* The ❯_ button, pinned outside the chips (which scroll sideways on a phone): always on screen. */}
      {extra && <div className="t-header-pin">{extra}</div>}
      {turn && !isChild && (
        <div className="t-inline-status t-turn-settings" role="status">
          <span>
            {turn.who === "subagent" ? "A subagent still runs with" : "This turn still runs with"}{" "}
            {[
              turn.model !== undefined && `Model ${modelLabel(turn.model, models?.models)}`,
              turn.effort !== undefined && `Effort ${effortLabel(turn.effort)}`,
              turn.permissionMode !== undefined && `Mode ${permissionModeLabel(turn.permissionMode)}`,
            ]
              .filter(Boolean)
              .join(", ")}
            .
          </span>
          {tighter && (
            // A subagent's: stop just it (a newer turn, pinned as shown, goes on).
            <Button
              label={turn.who === "subagent" && turn.subagentSessionId ? "Stop the subagent" : "Stop this turn"}
              size="sm"
              variant="secondary"
              onClick={() => void call(rpc(runnerId, "interrupt", { sessionId: turn.who === "subagent" && turn.subagentSessionId ? turn.subagentSessionId : session.id }))}
            />
          )}
        </div>
      )}
      {error && <div className="t-inline-status error">{error}</div>}
    </div>
  );
}
