import { DropdownMenu, DropdownMenuCheckboxItem } from "@astryxdesign/core/DropdownMenu";
import { ChevronDownIcon, DevicePhoneMobileIcon } from "@heroicons/react/16/solid";

/**
 * The session's "Session can text me" box (SPEC §11 Texting), off by default: only a ticked session
 * texts the person (its requests, its turns' ends, its agent's text_person), and plain texts go to
 * one of them. The chip says so only when it's on.
 */
export function TextMeChip({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <DropdownMenu
      renderTrigger={(p) => (
        <button type="button" className={`t-chip t-text-me-chip${on ? " t-text-me-on" : ""}`} title={on ? "This session can text you" : "This session doesn't text you"} aria-label={on ? "Texts: this session can text you" : "Texts: off"} {...p}>
          <DevicePhoneMobileIcon aria-hidden />
          {on && <span>Texts you</span>}
          <ChevronDownIcon aria-hidden />
        </button>
      )}
    >
      <DropdownMenuCheckboxItem label="Session can text me" description="Its questions and answers come to your phone, and your plain texts can go to it." value={on} onChange={onChange} />
    </DropdownMenu>
  );
}
