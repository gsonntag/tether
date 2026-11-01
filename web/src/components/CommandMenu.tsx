// The menu over the message box (SPEC §9 Commands): a session's commands and skills, as "/" and the
// name so far filter them. The keys stay in the box (Composer); a mouse press doesn't take focus.

import { useEffect, useRef } from "react";
import type { HarnessCommand } from "../../../shared/commands";

export function CommandMenu({ items, active, onPick }: { items: HarnessCommand[]; active: number; onPick: (c: HarnessCommand) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div ref={list} id="t-command-menu" className="t-command-menu" role="listbox" aria-label="Commands">
      {items.map((c, i) => (
        <button key={c.name} id={`t-command-${c.name}`} type="button" role="option" aria-selected={i === active} className={`t-command${i === active ? " active" : ""}`} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(c)}>
          <span className="t-command-name">
            /{c.name}
            {c.args && <span className="t-command-args"> {c.args}</span>}
          </span>
          {c.skill && <span className="t-command-kind">Skill</span>}
          <span className="t-command-desc">{c.description}</span>
        </button>
      ))}
    </div>
  );
}
