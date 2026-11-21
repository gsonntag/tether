import { useMemo, useState } from "react";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { Popover } from "@astryxdesign/core/Popover";
import { HARNESS_LABELS } from "../../../shared/transcript";
import { openSession } from "../route";
import type { Row } from "../sessionList";
import { byChildOrder } from "../subagents";
import { StatusDot } from "./SessionRow";
import "./SubagentChips.css";

/** Running subagents shown as chips of their own beside the count. */
const RUNNING_CHIPS = 3;
/** Above this many, the list gets a search box. */
const SEARCH_FROM = 8;

const label = (c: Row) => c.title || c.agentType || "Untitled";
/** What kind of child: a subagent's type, or a started session's harness (SPEC §6a). */
export const childKind = (c: Row) => (c.spawned ? `${HARNESS_LABELS[c.harness] ?? c.harness} · started by agent` : c.agentType);

/** Running first, then the most recent. */
export const bySubagentOrder = byChildOrder;

/**
 * Every subagent of a session in a popover (searchable when long), opened by `trigger`: a button.
 * Picking one opens it; `onPick` also runs (the phone drawer closes).
 */
export function SubagentsPopover({ runnerId, children, trigger, onPick }: { runnerId: string; children: Row[]; trigger: React.ReactNode; onPick?: () => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const sorted = useMemo(() => bySubagentOrder(children), [children]);
  const q = query.trim().toLowerCase();
  const shown = q ? sorted.filter((c) => `${label(c)} ${childKind(c) ?? ""}`.toLowerCase().includes(q)) : sorted;
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
            {childKind(c) && <span className="t-sub-item-type">{childKind(c)}</span>}
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

/**
 * The sessions this one's agent started (tether_start, SPEC §6a) in its header: one chip, its
 * menu lists them (running first). Ordinary sessions: picking one opens it.
 */
export function StartedChips({ runnerId, started }: { runnerId: string; started: Row[] }) {
  const sorted = useMemo(() => byChildOrder(started), [started]);
  if (!started.length) return null;
  const running = started.filter((c) => c.status !== "idle").length;
  return (
    <DropdownMenu
      renderTrigger={(p) => (
        <button type="button" className="t-chip t-started-chip" {...p} aria-label={`Sessions this one started: ${started.length}${running ? `, ${running} running` : ""}`}>
          {running > 0 && <StatusDot status="running" />}
          <span className="t-chip-key">Started</span>
          <span>{running ? `${running} running · ${started.length}` : started.length}</span>
        </button>
      )}
    >
      {sorted.map((c) => (
        <DropdownMenuItem key={c.id} label={c.title || "Untitled"} description={`${HARNESS_LABELS[c.harness] ?? c.harness} · ${c.status === "running" ? "Working" : c.status === "waiting" ? "Needs you" : "Idle"}`} onClick={() => openSession(runnerId, c.id)} />
      ))}
    </DropdownMenu>
  );
}
