import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { DropdownMenu, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@astryxdesign/core/DropdownMenu";
import { MODEL_ID_MAX, modelIdProblem } from "../../../shared/labels";
import type { Choice } from "../../../shared/transcript";

/**
 * A setting as a chip ("Model Haiku 5.5") that opens its choices. Picking applies at once: no
 * confirm, no save button.
 */
export function ChoiceMenu({
  name,
  value,
  label,
  choices,
  onPick,
  onOpen,
  disabled,
  customLabel,
}: {
  name: string;
  value?: string;
  label: string;
  choices: Choice[];
  onPick: (id: string) => void;
  onOpen?: () => void;
  /** why it can't be changed here now (shown instead of a menu) */
  disabled?: string;
  /** a last item that takes a typed name (SPEC §10 "Other model or deployment…"); the runner checks it too */
  customLabel?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [custom, setCustom] = useState("");
  const typed = custom.trim();
  const problem = modelIdProblem(typed);
  // The current value is always offered, even when the list doesn't (yet) have it.
  const list = value && !choices.some((c) => c.id === value) ? [{ id: value, label }, ...choices] : choices;
  if (disabled)
    return (
      <span className="t-chip t-chip-off" title={disabled} aria-label={`${name}: ${label}. ${disabled}`} aria-disabled="true">
        <span className="t-chip-key">{name}</span>
        <span>{label}</span>
      </span>
    );
  return (
    <>
    <DropdownMenu
      menuMaxHeight={420}
      onOpenChange={(open) => open && onOpen?.()}
      renderTrigger={(p) => (
        <button type="button" className="t-chip" {...p} aria-label={`${name}: ${label}`}>
          <span className="t-chip-key">{name}</span>
          <span>{label}</span>
        </button>
      )}
    >
      <DropdownMenuRadioGroup label={name} value={value} onChange={onPick}>
        {list.length === 0 ? <DropdownMenuRadioItem value="" label="Loading…" isDisabled /> : list.map((c) => <DropdownMenuRadioItem key={c.id} value={c.id} label={c.label} description={c.description} />)}
      </DropdownMenuRadioGroup>
      {customLabel && <DropdownMenuItem label={customLabel} onClick={() => { setCustom(value === "default" ? "" : value ?? ""); setEditing(true); }} />}
    </DropdownMenu>
    {editing && <Dialog isOpen onOpenChange={(open) => !open && setEditing(false)} width={420} purpose="form">
      <DialogHeader title="Other model or deployment" onOpenChange={(open) => !open && setEditing(false)} />
      <form className="t-form t-custom-model" style={{ padding: 16 }} onSubmit={(e) => { e.preventDefault(); if (!problem) { onPick(typed); setEditing(false); } }}>
        <label><span className="t-field-label">Name</span><input className="t-search" autoFocus required maxLength={MODEL_ID_MAX + 8} value={custom} onChange={(e) => setCustom(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} aria-invalid={!!typed && !!problem} /></label>
        {typed && problem && <div className="t-form-error">{problem}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}><Button label="Cancel" variant="secondary" onClick={() => setEditing(false)} /><Button label="Apply" variant="primary" type="submit" isDisabled={!!problem} /></div>
      </form>
    </Dialog>}
    </>
  );
}
