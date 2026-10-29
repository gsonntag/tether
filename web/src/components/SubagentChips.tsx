import { useMemo, useState } from "react";
import { Popover } from "@astryxdesign/core/Popover";
import { openSession } from "../route";
import type { Row } from "../sessionList";
import { StatusDot } from "./SessionRow";
import "./SubagentChips.css";

/** Running subagents shown as chips of their own beside the count. */
const RUNNING_CHIPS = 3;
/** Above this many, the list gets a search box. */
const SEARCH_FROM = 8;

const label = (c: Row) => c.title || c.agentType || "Untitled";

/** Running first, then the most recent. */
export const bySubagentOrder = (children: Row[]) => [...children].sort((a, b) => Number(b.status !== "idle") - Number(a.status !== "idle") || b.updatedAt - a.updatedAt);

/**
 * Every subagent of a session in a popover (searchable when long), opened by `trigger`: a button.
 * Picking one opens it; `onPick` also runs (the phone drawer closes).
 */
export function SubagentsPopover({ runnerId, children, trigger, onPick }: { runnerId: string; children: Row[]; trigger: React.ReactNode; onPick?: () => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const sorted = useMemo(() => bySubagentOrder(children), [children]);
  const q = query.trim().toLowerCase();
  const shown = q ? sorted.filter((c) => `${label(c)} ${c.agentType ?? ""}`.toLowerCase().includes(q)) : sorted;
  const list = (
    <div className="t-sub-pop">
      {children.length > SEARCH_FROM && (
        <input className="t-search t-sub-search" type="search" placeholder="Search subagents" aria-label="Search subagents" value={query} onChange={(e) => setQuery(e.target.value)} />
      )}
      <div className="t-sub-list" role="list">
        {shown.map((c) => (
          <button
            key={c.id}
            type="button"
            role="listitem"
            className="t-sub-item"
            title={label(c)}
            onClick={() => {
              setOpen(false);
              openSession(runnerId, c.id);
              onPick?.();
            }}
          >
            <span className="t-sub-item-dot">
              <StatusDot status={c.status} />
            </span>
            <span className="t-sub-item-title">{label(c)}</span>
            {c.agentType && <span className="t-sub-item-type">{c.agentType}</span>}
          </button>
        ))}
        {!shown.length && <div className="t-sub-empty">No subagent matches.</div>}
      </div>
    </div>
  );
  return (
    <Popover content={list} isOpen={open} onOpenChange={(o) => (setOpen(o), o || setQuery(""))} width={380} padding={0} label="Subagents" placement="below" alignment="start">
      {trigger}
    </Popover>
  );
}

/**
 * A session's subagents in its header: a few as chips, more behind a count that opens the list
 * (a session can have a hundred; the transcript keeps the screen).
 */
export function SubagentChips({ runnerId, children }: { runnerId: string; children: Row[] }) {
  const sorted = useMemo(() => bySubagentOrder(children), [children]);
  if (!children.length) return null;
  const chip = (c: Row, extra = "") => (
    <button key={c.id} type="button" className={`t-chip t-sub-chip${extra}`} title={label(c)} onClick={() => openSession(runnerId, c.id)}>
      <StatusDot status={c.status} />
      <span className="t-chip-key">Subagent</span>
      <span className="t-sub-chip-title">{label(c)}</span>
    </button>
  );
  if (children.length <= RUNNING_CHIPS) return <>{sorted.map((c) => chip(c))}</>;
  const running = sorted.filter((c) => c.status !== "idle");
  return (
    <>
      <SubagentsPopover
        runnerId={runnerId}
        children={children}
        trigger={
          <button type="button" className="t-chip" aria-label={`Subagents: ${children.length}${running.length ? `, ${running.length} running` : ""}`}>
            {running.length > 0 && <StatusDot status="running" />}
            <span className="t-chip-key">Subagents</span>
            <span>{running.length ? `${running.length} running · ${children.length}` : children.length}</span>
          </button>
        }
      />
      {running.slice(0, RUNNING_CHIPS).map((c) => chip(c, " t-sub-running"))}
    </>
  );
}
