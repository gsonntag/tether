import { Fragment, useEffect, useMemo, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { HomeIcon, LinkIcon, PlusIcon, UserCircleIcon } from "@heroicons/react/24/outline";
import type { ProjectInfo } from "../../../shared/transcript";
import { rpc } from "../connection";
import { navigate, useRoute } from "../route";
import { folderName, mergeRows, recentSessions, waitingOn, type Row } from "../sessionList";
import { useStore } from "../store";
import { RunnerDot } from "./RunnerStatus";
import { SessionRow } from "./SessionRow";
import { useChildren } from "./useChildren";
import { bySubagentOrder, SubagentsPopover } from "./SubagentChips";

/** Subagent rows shown under a session before "N more". */
const CHILD_ROWS = 5;
import { useNow } from "./useNow";

const PAGE = 40;

export function Sidebar() {
  const runners = useStore((s) => s.runners);
  const user = useStore((s) => s.user);
  const summaries = useStore((s) => s.summaries);
  const projectsBy = useStore((s) => s.projects);
  const filter = useStore((s) => s.projectFilter);
  const linkOpen = useStore((s) => s.link === "open");
  const route = useRoute();
  const now = useNow();
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const close = () => useStore.setState({ sidebarOpen: false });
  const online = runners.filter((r) => r.online);
  const onlineKey = online.map((r) => r.id).join(",");
  const many = online.length > 1;
  const runnerName = (id: string) => runners.find((r) => r.id === id)?.name ?? id;

  // Older sessions the summary list doesn't carry: the runner searches all titles, or a whole folder.
  const [extra, setExtra] = useState<{ for: string; rows: Row[] }>({ for: "", rows: [] });
  const q = query.trim();
  const extraKey = `${filter ?? ""}\u0000${q}`;
  useEffect(() => {
    if (!linkOpen || (!filter && !q)) return;
    let gone = false;
    const t = setTimeout(async () => {
      const lists = await Promise.all(
        online.map((r) =>
          rpc(r.id, "listSessions", filter ? { projectPath: filter, ...(q ? { query: q } : {}) } : { query: q })
            .then((x) => x.sessions.map((s) => ({ ...s, runnerId: r.id })))
            .catch(() => [] as Row[]),
        ),
      );
      if (!gone) setExtra({ for: extraKey, rows: lists.flat() });
    }, q ? 250 : 0);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [extraKey, linkOpen, onlineKey]);

  const rows = useMemo(() => {
    let list = recentSessions(summaries, q);
    if (filter) list = list.filter((r) => r.projectPath === filter);
    if (extra.for === extraKey) list = mergeRows(extra.rows.filter((r) => !r.parentSessionId), list);
    return list;
  }, [summaries, q, filter, extra, extraKey]);

  const projects = useMemo(() => {
    const by = new Map<string, ProjectInfo & { runnerIds: string[] }>();
    for (const [runnerId, list] of Object.entries(projectsBy))
      for (const p of list) {
        const had = by.get(p.path);
        by.set(p.path, had ? { ...had, sessions: had.sessions + p.sessions, updatedAt: Math.max(had.updatedAt, p.updatedAt), runnerIds: [...had.runnerIds, runnerId] } : { ...p, runnerIds: [runnerId] });
      }
    return [...by.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [projectsBy]);

  const selected = route.page === "session" ? route : undefined;
  // An open subagent shows under its parent, so the parent's row is the one expanded.
  const selParent = useStore((s) => (selected ? (s.summaries[selected.runnerId]?.sessions[selected.sessionId]?.parentSessionId ?? s.views[`${selected.runnerId}\u0000${selected.sessionId}`]?.session?.parentSessionId) : undefined));
  const expanded = selected && { runnerId: selected.runnerId, sessionId: selParent ?? selected.sessionId };
  const children = useChildren(expanded?.runnerId, expanded?.sessionId);
  const selectedRow = expanded && rows.slice(0, shown).find((r) => r.runnerId === expanded.runnerId && r.id === expanded.sessionId);
  const childRow = (c: Row) => <SessionRow key={c.id} row={c} now={now} selected={!!selected && c.id === selected.sessionId} child />;
  // A session can have a hundred subagents: a few rows (running first, the open one always), the
  // rest behind "N more", which opens the whole list.
  const childRows = () => {
    const sorted = bySubagentOrder(children);
    const few = sorted.slice(0, CHILD_ROWS);
    const open = selected && sorted.find((c) => c.id === selected.sessionId);
    if (open && !few.includes(open)) few.push(open);
    const rest = children.length - few.length;
    return (
      <>
        {few.map(childRow)}
        {rest > 0 && expanded && (
          <SubagentsPopover
            runnerId={expanded.runnerId}
            children={children}
            onPick={() => useStore.setState({ sidebarOpen: false })}
            trigger={
              <button type="button" className="t-more t-child-more">
                {rest} more subagent{rest === 1 ? "" : "s"}
              </button>
            }
          />
        )}
      </>
    );
  };

  return (
    <SideNav
      header={<SideNavHeading heading="Tether" icon={<NavIcon icon={<Icon icon={LinkIcon} size="sm" />} />} />}
      footer={
        user && (
          <SideNavSection title="Account" isHeaderHidden>
            <SideNavItem label={user.name || user.email} icon={UserCircleIcon} />
          </SideNavSection>
        )
      }
    >
      <div className="t-side-tools">
        <Button
          label="New session"
          variant="primary"
          icon={<Icon icon={PlusIcon} size="sm" />}
          isDisabled={!online.length}
          onClick={() => {
            close();
            useStore.setState({ newSessionOpen: true });
          }}
        />
        <input className="t-search" type="search" placeholder="Search sessions" aria-label="Search sessions" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <SideNavSection title="Menu" isHeaderHidden>
        <SideNavItem
          label="Home"
          icon={HomeIcon}
          isSelected={route.page === "home"}
          onClick={() => {
            navigate({ page: "home" });
            close();
          }}
        />
      </SideNavSection>

      <div className="t-list-head">
        {filter ? (
          <>
            <button type="button" onClick={() => useStore.setState({ projectFilter: undefined })} aria-label="Back to all sessions">
              ← All
            </button>
            <span className="t-grow" title={filter}>
              {folderName(filter)}
            </span>
          </>
        ) : (
          <span className="t-grow">{q ? "Matching sessions" : "Recent"}</span>
        )}
      </div>
      <div className="t-rows">
        {rows.length === 0 && <div className="t-empty-line">{q ? "No sessions match." : online.length ? "No sessions yet." : "No runner connected."}</div>}
        {rows.slice(0, shown).map((r) => {
          const isExp = !!expanded && r.runnerId === expanded.runnerId && r.id === expanded.sessionId;
          return (
            <Fragment key={`${r.runnerId}:${r.id}`}>
              <SessionRow row={r} now={now} selected={isExp && !selParent} runnerLabel={many ? runnerName(r.runnerId) : undefined} />
              {isExp && childRows()}
            </Fragment>
          );
        })}
        {rows.length > shown && (
          <button type="button" className="t-more" onClick={() => setShown(shown + PAGE)}>
            Show more
          </button>
        )}
      </div>
      {/* An open session not in the list above (a subagent, or one further down): its subagents. */}
      {selected && !selectedRow && children.length > 0 && (
        <>
          <div className="t-list-head">
            <span className="t-grow">Subagents of this session</span>
          </div>
          <div className="t-rows">
            {childRows()}
          </div>
        </>
      )}

      {!filter && projects.length > 0 && (
        <>
          <div className="t-list-head">
            <span className="t-grow">Projects</span>
          </div>
          <div className="t-rows">
            {projects.slice(0, 30).map((p) => (
              <button
                type="button"
                key={p.path}
                className="t-row"
                title={p.path}
                onClick={() => {
                  useStore.setState({ projectFilter: p.path });
                  setShown(PAGE);
                }}
              >
                <span className="t-row-title">{p.name || folderName(p.path)}</span>
                <span className="t-row-meta">
                  <span className="t-proj">{p.sessions === 1 ? "1 session" : `${p.sessions} sessions`}</span>
                  {many && <span className="t-proj">· {p.runnerIds.map(runnerName).join(", ")}</span>}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {runners.length > 0 && (
        <SideNavSection title="Runners">
          {runners.map((r) => (
            <SideNavItem
              key={r.id}
              label={r.name || r.id}
              onClick={() => {
                navigate({ page: "home" });
                close();
              }}
              endContent={
                <>
                  {waitingOn(summaries, r.id).length > 0 && <span className="t-needs">{waitingOn(summaries, r.id).length} need you</span>}
                  <RunnerDot runner={r} now={now} />
                </>
              }
            />
          ))}
        </SideNavSection>
      )}
    </SideNav>
  );
}
