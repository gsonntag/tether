import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HARNESS_KEYS, keyTargets, type CredentialSource, type SourceChoices } from "../../../shared/credentials";
import type { HarnessId, LiveState } from "../../../shared/transcript";

const labels: Record<CredentialSource, string> = { anthropic: "Anthropic API key", openai: "OpenAI API key", azure: "Azure" };

export function FallbackKeysDialog({ harness, state, choices, onSave, onClose }: { harness: HarnessId; state: LiveState; choices: SourceChoices; onSave: (keys: CredentialSource[]) => Promise<void>; onClose: () => void }) {
  const [order, setOrder] = useState<CredentialSource[]>(() => state.fallbackKeys ?? keyTargets(choices.options, state.lastKey).map((o) => o.source as CredentialSource));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const move = (index: number, by: number) => setOrder((old) => {
    const next = [...old];
    [next[index], next[index + by]] = [next[index + by]!, next[index]!];
    return next;
  });
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try { await onSave(order); onClose(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const keys = [...order, ...HARNESS_KEYS[harness].filter((key) => !order.includes(key))];
  return <Dialog isOpen onOpenChange={(open) => !open && !busy && onClose()} width={420} purpose="form">
    <DialogHeader title="Fallback keys" onOpenChange={(open) => !open && !busy && onClose()} />
    <div className="t-form" style={{ padding: 16 }}>
      <p className="t-inline-status">When the plan runs out, use the first available checked key in this order. Unchecked keys are excluded.</p>
      {keys.map((key) => {
        const index = order.indexOf(key);
        const available = choices.options.some((o) => o.source === key);
        return <div key={key} className="t-fallback-row">
          <label className="t-check"><input type="checkbox" checked={index >= 0} disabled={busy} onChange={(e) => setOrder((old) => e.target.checked ? [...old, key] : old.filter((k) => k !== key))} /><span>{index >= 0 ? `${index + 1}. ` : ""}{labels[key]}{available ? "" : " (not set)"}</span></label>
          {index >= 0 && <div className="t-fallback-actions">
            <button type="button" aria-label={`Move ${labels[key]} up`} disabled={busy || index === 0} onClick={() => move(index, -1)}>↑</button>
            <button type="button" aria-label={`Move ${labels[key]} down`} disabled={busy || index === order.length - 1} onClick={() => move(index, 1)}>↓</button>
          </div>}
        </div>;
      })}
      {order.length === 0 && <span className="t-inline-status">All keys excluded. This session will stay on the plan.</span>}
      {error && <div className="t-form-error">{error}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button label="Cancel" variant="secondary" isDisabled={busy} onClick={onClose} />
        <Button label={busy ? "Saving…" : "Save"} variant="primary" isDisabled={busy} onClick={() => void save()} />
      </div>
    </div>
  </Dialog>;
}
