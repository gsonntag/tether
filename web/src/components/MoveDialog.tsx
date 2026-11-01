import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { effortLabel, findModel, isApiBilling, modelLabel, permissionModeLabel, prettyModel } from "../../../shared/labels";
import type { MoveOptions } from "../../../shared/move";
import { CLAUDE_UNSET, type HarnessId, type SessionSummary } from "../../../shared/transcript";
import { rpc } from "../connection";
import { openSession } from "../route";
import { loadModels, modelListKey, useStore } from "../store";
import { focusComposerOf } from "./SessionView";

/** The session's menu, in the header: Move to… and its dialog (SPEC §15). */
export function SessionMenu({ runnerId, session }: { runnerId: string; session: SessionSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <DropdownMenu
        renderTrigger={(p) => (
          <button type="button" className="t-chip t-chip-term t-chip-more" {...p} aria-label="Session menu">
            <span aria-hidden>⋯</span>
          </button>
        )}
      >
        <DropdownMenuItem label="Move to…" onClick={() => setOpen(true)} />
      </DropdownMenu>
      {open && <MoveDialog runnerId={runnerId} session={session} onClose={() => setOpen(false)} />}
    </>
  );
}

function MoveDialog({ runnerId, session, onClose }: { runnerId: string; session: SessionSummary; onClose: () => void }) {
  const [options, setOptions] = useState<MoveOptions>();
  const [picked, setPicked] = useState<HarnessId>();
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    rpc(runnerId, "moveOptions", { sessionId: session.id }).then(setOptions, (e) => setError((e as Error).message));
  }, [runnerId, session.id]);

  const targets = options?.targets ?? [];
  const target = targets.find((t) => t.harness === picked) ?? targets[0];
  const harness = target?.harness;
  const models = useStore((s) => (harness ? s.modelLists[modelListKey(runnerId, harness)] : undefined));
  useEffect(() => {
    setModel("");
    setEffort("");
    if (harness) void loadModels(runnerId, harness);
  }, [runnerId, harness]);

  // Unset: what a new session there runs. Claude's are spelled out (CLAUDE_UNSET), the rest "Default".
  const isClaude = harness === "claude";
  const listed = models?.models.length ? models.models : isClaude ? [{ id: CLAUDE_UNSET.model, label: prettyModel(CLAUDE_UNSET.model) }] : [{ id: "default", label: "Default" }];
  const unpicked = isClaude ? (findModel(listed, CLAUDE_UNSET.model)?.id ?? CLAUDE_UNSET.model) : "default";
  const shownModel = model || unpicked;
  const efforts = findModel(listed, shownModel)?.efforts ?? [];
  const unsetEffort = isClaude && efforts.includes(CLAUDE_UNSET.effort) ? CLAUDE_UNSET.effort : "";
  const validEffort = efforts.includes(effort) ? effort : "";

  const move = async () => {
    if (!harness || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const { sessionId } = await rpc(runnerId, "moveSession", { sessionId: session.id, harness, ...(model && model !== "default" && !target?.deployment ? { model } : {}), ...(validEffort ? { effort: validEffort } : {}) });
      onClose();
      focusComposerOf(runnerId, sessionId);
      openSession(runnerId, sessionId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const blocked = options?.blocked;
  return (
    <Dialog isOpen onOpenChange={(o) => !o && !busy && onClose()} width={420} purpose="form">
      <DialogHeader title="Move to…" onOpenChange={(o) => !o && !busy && onClose()} />
      <div className="t-form" style={{ padding: 16 }}>
        {targets.length > 1 && (
          <div className="t-seg" role="radiogroup" aria-label="Agent">
            {targets.map((t) => (
              <button type="button" role="radio" aria-checked={t.harness === harness} key={t.harness} className={`t-seg-opt${t.harness === harness ? " on" : ""}`} onClick={() => setPicked(t.harness)}>
                {t.label}
              </button>
            ))}
          </div>
        )}
        {targets.length === 1 && <div className="t-move-to">{target!.label}</div>}
        {options && !targets.length && <div className="t-form-error">No other agent on this runner.</div>}
        {target && (
          <>
            {target.deployment ? (
              <div>
                <span className="t-field-label">Deployment</span>
                <div>{target.deployment}</div>
              </div>
            ) : (<label>
              <span className="t-field-label">Model</span>
              <select className="t-select" value={shownModel} onChange={(e) => setModel(e.target.value)}>
                {listed.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id === "default" ? modelLabel("default", models?.models) : m.label}
                  </option>
                ))}
              </select>
            </label>)}
            {efforts.length > 0 && !target.deployment && (
              <label>
                <span className="t-field-label">Effort</span>
                <select className="t-select" value={validEffort || unsetEffort} onChange={(e) => setEffort(e.target.value)}>
                  {!isClaude && <option value="">Default</option>}
                  {efforts.map((e) => (
                    <option key={e} value={e}>
                      {effortLabel(e)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <dl className="t-move-facts">
              <dt>Mode</dt>
              <dd>{permissionModeLabel(target.permissionMode)}</dd>
              {target.billing && (
                <>
                  <dt>Billing</dt>
                  <dd>{isApiBilling(target.billing) ? <span className="t-move-api">{target.billing.label}</span> : target.billing.label}</dd>
                </>
              )}
            </dl>
          </>
        )}
        {options?.background && <div className="t-inline-status">Background work stays here.</div>}
        {blocked && <div className="t-form-error">{blocked}</div>}
        {error && <div className="t-form-error">{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button label="Cancel" variant="secondary" isDisabled={busy} onClick={onClose} />
          <Button label={busy ? "Moving…" : "Move"} variant="primary" isDisabled={!target || !!blocked || busy} onClick={() => void move()} />
        </div>
      </div>
    </Dialog>
  );
}
