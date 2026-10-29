import { DropdownMenu, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@astryxdesign/core/DropdownMenu";
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
}: {
  name: string;
  value?: string;
  label: string;
  choices: Choice[];
  onPick: (id: string) => void;
  onOpen?: () => void;
  /** why it can't be changed here now (shown instead of a menu) */
  disabled?: string;
}) {
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
    </DropdownMenu>
  );
}
