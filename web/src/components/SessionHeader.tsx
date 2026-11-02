import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { StopIcon } from "@heroicons/react/24/outline";
import { isApiBilling, contextDetail, contextPercent, effortLabel, findModel, modelLabel, permissionModeLabel } from "../../../shared/labels";
import { HARNESS_LABELS, type HarnessCapabilities, type LiveState, type ModelList, type SessionSummary } from "../../../shared/transcript";
import { rpc } from "../connection";
import { openSession } from "../route";
import type { Row } from "../sessionList";
import { loadModels } from "../store";
import { BillingChip, useSources } from "./BillingChip";
import { ChoiceMenu } from "./ChoiceMenu";
import { shownStatus } from "../sessionList";
import { StatusDot } from "./SessionRow";
import { SubagentChips } from "./SubagentChips";
import { MODEL_AFTER_SOURCE } from "../../../shared/sourceSwitch";
import { billingForDisplay, visibleNextBilling } from "../sourceMenu";

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
  const paid = isApiBilling(billingForDisplay(state));
  const nextBilling = visibleNextBilling(state);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleBusy, setTitleBusy] = useState(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const editing = useRef(false);
  useEffect(() => { if (editingTitle) { titleInput.current?.focus(); titleInput.current?.select(); } }, [editingTitle]);
  const finishTitle = (save: boolean) => {
    if (!editing.current) return;
    editing.current = false;
    const title = titleInput.current?.value.trim();
    setEditingTitle(false);
    if (save && title && title !== session.title) {
      setTitleBusy(true);
      void call(rpc(runnerId, "renameSession", { sessionId: session.id, title })).finally(() => setTitleBusy(false));
    }
  };
  const call = async (p: Promise<unknown>) => {
    setError(undefined);
    try {
      await p;
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const ensureModels = () => void (models ? undefined : loadModels(runnerId, session.harness, session.id));
  // "Default" reads as what it runs: stored, the session doesn't say, the list does.
  useEffect(() => {
    if (state.model === "default" && !state.modelResolved) ensureModels();
  }, [state.model, state.modelResolved, !!models]);
  // The source the next start uses, as the runner decides it: a harness that carries a source change
  // to a new thread (Codex) starts this thread on its confirmed source, and its model can't change
  // until the change is done (the runner refuses too); one that switches in place starts on the new one.
  const sourcePending = !!capabilities?.sourceCarry && !!state.nextBilling;
  const onAzure = (capabilities?.sourceCarry ? state.billing : billingForDisplay(state))?.label === "Azure";
  const { choices: sources, refresh: refreshSources } = useSources(runnerId, session.harness, onAzure);
  const azureModels = sources?.options.find((o) => o.source === "azure")?.deployments?.map((d) => ({ id: d.name, label: d.model ? `${d.name} · ${d.model}` : d.name, description: undefined }));
  const current = findModel(models?.models ?? [], state.model);
  // A handoff TUI drives (SPEC §8): it takes no settings from Tether.
  const locked = state.mode === "terminal" && capabilities?.terminal === "handoff" ? `${HARNESS_LABELS[session.harness]}'s terminal is driving. Change it there.` : undefined;
  // Changed during a turn on a harness where that counts from the next turn: the turn's own values.
  const turn = state.turnSettings;
  const nextTurn = (now: string, was: string | undefined, shown?: string) => (was !== undefined && was !== shown && (turn?.who === undefined || turn.who === "turn") ? `${now} from the next turn` : now);
  const modes = models?.permissionModes ?? [];
  // Tighter: earlier in the harness's list of modes (strictest first), so this turn runs looser than shown.
  const rank = (m?: string) => modes.findIndex((x) => x.id === m);
  // The harness says (by approval policy and sandbox, for any combination); else by the list's order.
  const tighter = turn?.looser ?? (turn?.permissionMode !== undefined && rank(state.permissionMode) >= 0 && rank(turn.permissionMode) > rank(state.permissionMode));
  const efforts = current?.efforts ? (models?.efforts ?? []).filter((e) => current.efforts!.includes(e.id)) : (models?.efforts ?? []);

  return (
    <div className="t-header">
      <div className="t-header-top">
        {editingTitle ? <input ref={titleInput} className="t-title-input" aria-label="Session title" defaultValue={session.title} maxLength={200} onBlur={() => finishTitle(true)} onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); finishTitle(e.key === "Enter"); }
        }} /> : <button type="button" className="t-header-title t-title-button" title={session.title} aria-label={`Rename session: ${session.title || "Untitled"}`} disabled={titleBusy} onClick={() => { editing.current = true; setEditingTitle(true); }}>{session.title || "Untitled"}</button>}
        <StatusDot status={shownStatus(state)} requests={state.requests.length} />
        {isChild && state.status === "running" && (
          <Button label="Stop" size="sm" variant="secondary" icon={<Icon icon={StopIcon} size="sm" />} onClick={() => void call(rpc(runnerId, "interrupt", { sessionId: session.id }))} />
        )}
      </div>
      <div className="t-header-sub" title={session.projectPath}>
        {isChild ? `Subagent${session.agentType ? ` · ${session.agentType}` : ""} · ${session.projectPath}` : session.projectPath}
      </div>
      <div className={`t-chips${paid ? " t-paid-chips" : ""}`}>
        <BillingChip runnerId={runnerId} session={session} state={state} capabilities={capabilities} onSwitch={(source) => void call(rpc(runnerId, "setSessionSource", { sessionId: session.id, source }))} onAutoKey={(on) => void call(rpc(runnerId, "setAutoKey", { sessionId: session.id, on }))} />
        {nextBilling && <span className={`t-chip t-chip-info t-next-source${isApiBilling(nextBilling) ? " t-next-api" : ""}`} title={`${nextBilling.label} from the next start`}>Next: {nextBilling.label}</span>}
        <div className="t-chip-options">
        {isChild ? (
          <button type="button" className="t-chip" onClick={() => openSession(runnerId, session.parentSessionId!)}>
            ← Main session
          </button>
        ) : (
          <>
            <ChoiceMenu
              name="Model"
              customLabel={session.harness === "codex" ? "Other model or deployment…" : undefined}
              value={current?.id ?? state.model}
              // While the TUI drives, its /model is what runs: Tether shows the last it knew.
              label={locked ? `Set in the terminal (last seen: ${modelLabel(state.model, models?.models, state.modelResolved)})` : nextTurn(modelLabel(state.model, models?.models, state.modelResolved), turn?.model, state.model)}
              disabled={locked ?? (sourcePending ? MODEL_AFTER_SOURCE : undefined)}
              choices={(onAzure ? azureModels ?? [] : models?.models ?? []).map((m) => ({ id: m.id, label: m.label, description: m.description }))}
              onOpen={() => { ensureModels(); if (onAzure) refreshSources(); }}
              // A refusal shows in the chat, from the runner.
              onPick={(model) => void rpc(runnerId, "setModel", { sessionId: session.id, model }).catch(() => {})}
            />
            {state.nextDeployment && <span className="t-chip t-chip-info t-next-deployment" title={`${state.nextDeployment} from the next message`}>Next: {state.nextDeployment}</span>}
            {(efforts.length > 0 || state.effort) && (
              <ChoiceMenu name="Effort" value={state.effort} label={locked ? `Set in the terminal (last seen: ${effortLabel(state.effort)})` : nextTurn(effortLabel(state.effort), turn?.effort, state.effort)} disabled={locked} choices={efforts} onOpen={ensureModels} onPick={(effort) => void call(rpc(runnerId, "setEffort", { sessionId: session.id, effort }))} />
            )}
            <ChoiceMenu
              name="Mode"
              value={state.permissionMode}
              // While Claude's TUI drives, its mode comes from its status line and hooks: the last they showed.
              label={locked ? `Set in the terminal (last seen: ${permissionModeLabel(state.permissionMode)})` : nextTurn(permissionModeLabel(state.permissionMode), turn?.permissionMode, state.permissionMode)}
              disabled={locked}
              choices={models?.permissionModes ?? []}
              onOpen={ensureModels}
              onPick={(mode) => void call(rpc(runnerId, "setPermissionMode", { sessionId: session.id, mode }))}
            />
          </>
        )}
        <SubagentChips runnerId={runnerId} children={children} />
        {/* Last in the row: where chips scroll sideways, these go out of view first. */}
        {!isChild && state.context && (
          <span className="t-chip t-chip-info t-context-chip" title={contextDetail(state.context)}>
            Context {contextPercent(state.context)}
          </span>
        )}
        </div>
      </div>
      {/* The ❯_ button, pinned outside the chips (which scroll sideways on a phone): always on screen. */}
      {extra && <div className="t-header-pin">{extra}</div>}
      {turn && !isChild && (
        <div className="t-inline-status t-turn-settings" role="status">
          <span>
            {turn.who === "background"
              ? `${turn.count === 1 ? "A background command still runs" : `${turn.count} background commands still run`} with${turn.mixed ? " up to" : ""}`
              : turn.who === "subagent"
                ? "A subagent still runs with"
                : "This turn still runs with"}{" "}
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
            // A subagent's: stop just it (a newer turn, pinned as shown, goes on). Commands: just them.
            <Button
              label={turn.who === "background" ? (turn.count === 1 ? "Stop the command" : "Stop the commands") : turn.who === "subagent" && turn.subagentSessionId ? "Stop the subagent" : "Stop this turn"}
              size="sm"
              variant="secondary"
              onClick={() => void call(turn.who === "background" ? rpc(runnerId, "stopBackground", { sessionId: session.id }) : rpc(runnerId, "interrupt", { sessionId: turn.who === "subagent" && turn.subagentSessionId ? turn.subagentSessionId : session.id }))}
            />
          )}
        </div>
      )}
      {error && <div className="t-inline-status error">{error}</div>}
    </div>
  );
}
