import { Fragment, useEffect, useMemo, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import { Selector } from "@astryxdesign/core/Selector";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Cog6ToothIcon, HomeIcon, LinkIcon, PlusIcon, UserCircleIcon } from "@heroicons/react/24/outline";
import type { ProjectInfo } from "../../../shared/transcript";
import { rpc } from "../connection";
import { navigate, useRoute } from "../route";
import { ancestorChain, foldWorktrees, folderName, inProject, isHomeChat, listed, recentGroups, mergeRows, recentSessions, splitPinned, startedChildrenOf, waitingOn, type Row } from "../sessionList";
import { activeRunnerFilter, aggregateProjects } from "../runnerFilter";
import { avatarSrc } from "../avatar";
import { canPin } from "../runners";
import { defaultSettingsPage, isSettingsPage } from "../settings";
import { setRunnerFilter, useStore } from "../store";
import { RunnerDot } from "./RunnerStatus";
import { SessionRow, StatusDot } from "./SessionRow";
import { useChildren } from "./useChildren";
import { SubagentsPopover } from "./SubagentChips";
import { childrenOpen, childrenToggle, fewChildren, loadChildrenOpen, moreLabel, saveChildrenOpen } from "../subagents";
import { useNow } from "./useNow";

/** Subagent rows shown under a session before "N more". */
const CHILD_ROWS = 5;
import { SidebarHandle } from "./WidthHandle";

const PAGE = 40;

export function Sidebar() {
  const runners = useStore((s) => s.runners);
  const user = useStore((s) => s.user);
  const summaries = useStore((s) => s.summaries);
  const projectsBy = useStore((s) => s.projects);
  const filter = useStore((s) => s.projectFilter);
  const runnerFilter = useStore((s) => s.runnerFilter);
  const linkOpen = useStore((s) => s.link === "open");
  const route = useRoute();
  const now = useNow();
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const close = () => useStore.setState({ sidebarOpen: false });
  const online = runners.filter((r) => r.online);
  const onlineKey = online.map((r) => r.id).join(",");
  const activeRunner = activeRunnerFilter(runnerFilter, online);
  const many = online.length > 1 && !activeRunner;
  const runnerName = (id: string) => runners.find((r) => r.id === id)?.name ?? id;

  // Older sessions the summary list doesn't carry: the runner searches all titles, or a whole folder.
  const [extra, setExtra] = useState<{ for: string; rows: Row[] }>({ for: "", rows: [] });
  const q = query.trim();
  const targetRunners = activeRunner ? online.filter((r) => r.id === activeRunner) : online;
  const extraKey = `${activeRunner ?? ""}\u0000${filter ?? ""}\u0000${q}`;
  useEffect(() => {
    if (!linkOpen || (!filter && !q)) return;
    let gone = false;
    const t = setTimeout(async () => {
      const lists = await Promise.all(
        targetRunners.map((r) =>
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
  // An archive change made here: the cached copy takes it, so the row leaves (or comes back) at once.
  const archiveEdit = useStore((s) => s.archiveEdit);
  useEffect(() => {
    if (!archiveEdit) return;
    const { runnerId, sessionId, archived } = archiveEdit;
    setExtra((e) => ({ ...e, rows: e.rows.map((r) => (r.runnerId === runnerId && r.id === sessionId ? { ...r, archived: archived || undefined } : r)) }));
  }, [archiveEdit]);

  const rows = useMemo(() => {
    let list = recentSessions(summaries, q, activeRunner);
    if (filter) list = list.filter((r) => inProject(r, filter));
    if (extra.for === extraKey) {
      const extraFiltered = extra.rows.filter((r) => (!activeRunner || r.runnerId === activeRunner) && listed(r) && (!r.archived || !!q) && !isHomeChat(r.runnerId, r.projectPath));
      list = mergeRows(extraFiltered, list);
    }
    return list;
  }, [summaries, q, filter, extra, extraKey, activeRunner]);
  // Pinned sessions sit above Recent; a search or a folder lists everything as one list.
  const { pinned, rest } = useMemo(() => (q || filter ? { pinned: [], rest: rows } : splitPinned(rows)), [rows, q, filter]);

  // A worktree folder a session is in shows under its main checkout, as Recent groups it: by every session known (a search doesn't undo it).
  const projects = useMemo(() => foldWorktrees(aggregateProjects(projectsBy, activeRunner), Object.values(summaries).flatMap((x) => Object.values(x.sessions))), [projectsBy, activeRunner, summaries]);

  const selected = route.page === "session" ? route : undefined;
  // Walk up parentSessionId / startedBy so an open subagent or agent-started session stays nested under its ancestor.
  const selChainKey = useStore((s) => (selected ? ancestorChain(s.summaries, s.views, selected.runnerId, selected.sessionId).join("\0") : ""));
  const selChain = useMemo(() => (selChainKey ? selChainKey.split("\0") : []), [selChainKey]);
  const expanded = selected && selChain.length ? { runnerId: selected.runnerId, sessionId: selChain[0]! } : undefined;
  const selActiveChild = selChain[1];
  const children = useChildren(expanded?.runnerId, expanded?.sessionId);
  const selectedRow = expanded && [...pinned, ...rest.slice(0, shown)].find((r) => r.runnerId === expanded.runnerId && r.id === expanded.sessionId);
  // Subagents (and sessions its agent started) sit behind one toggle row, open or closed as this
  // device keeps it; open while one of them is the open session, until toggled.
  const [savedOpen, setSavedOpen] = useState(loadChildrenOpen);
  const [toggled, setToggled] = useState<{ for: string; open: boolean }>();
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
  const selKey = selected ? `${selected.runnerId}\u0000${selected.sessionId}` : "";
  const sectionOpen = childrenOpen(savedOpen, children, selActiveChild, toggled?.for === selKey ? toggled.open : undefined);
  const renderChildList = (runnerId: string, list: Row[], open: boolean, onToggle: () => void, activeId?: string, activeRest: string[] = []) => {
    if (!list.length) return null;
    const { label, running, said } = childrenToggle(list);
    const toggle = (
      <button
        type="button"
        className="t-child-toggle"
        aria-expanded={open}
        aria-label={said}
        title={said}
        onClick={onToggle}
      >
        <span className="t-child-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="t-child-label">{label}</span>
        {running > 0 && (
          <span className="t-child-running" aria-hidden="true">
            <StatusDot status="running" />
            {running}
          </span>
        )}
      </button>
    );
    if (!open) return toggle;
    const { few, rest: more } = fewChildren(list, activeId, CHILD_ROWS);
    return (
      <>
        {toggle}
        {few.map((c) => (
          <Fragment key={c.id}>
            <SessionRow row={c} now={now} selected={!!selected && c.id === selected.sessionId} child />
            {c.id === activeId && selected && (
              <NestedBranch runnerId={runnerId} parentId={c.id} activeChain={activeRest} selectedId={selected.sessionId} now={now} />
            )}
          </Fragment>
        ))}
        {more.length > 0 && (
          <SubagentsPopover
            runnerId={runnerId}
            children={list}
            onPick={() => useStore.setState({ sidebarOpen: false })}
            trigger={
              <button type="button" className="t-more t-child-more">
                {moreLabel(more)}
              </button>
            }
          />
        )}
      </>
    );
  };
  const childRows = () =>
    expanded
      ? renderChildList(
          expanded.runnerId,
          children,
          sectionOpen,
          () => {
            const open = !sectionOpen;
            saveChildrenOpen(open);
            setSavedOpen(open);
            setToggled({ for: selKey, open });
          },
          selActiveChild,
          selChain.slice(2),
        )
      : null;

  /** `grouped`: under its project's subheader, so the row leaves the project out. */
  const sessionRow = (r: Row, grouped = false) => {
    const isExp = !!expanded && r.runnerId === expanded.runnerId && r.id === expanded.sessionId;
    const liveStarted = isExp ? [] : startedChildrenOf(summaries, r.runnerId, r.id);
    const otherKey = `${r.runnerId}\u0000${r.id}`;
    return (
      <Fragment key={`${r.runnerId}:${r.id}`}>
        <SessionRow row={r} now={now} selected={isExp && selChain.length === 1} runnerLabel={many ? runnerName(r.runnerId) : undefined} canPin={canPin(runners, r.runnerId)} hideProject={grouped} />
        {isExp
          ? childRows()
          : liveStarted.length > 0 &&
            renderChildList(r.runnerId, liveStarted, !!otherOpen[otherKey], () =>
              setOtherOpen((prev) => ({ ...prev, [otherKey]: !prev[otherKey] })),
            )}
      </Fragment>
    );
  };

  return (
    <div className="t-side-frame">
    <SideNav
      header={<SideNavHeading heading="Tether" icon={<NavIcon icon={<Icon icon={LinkIcon} size="sm" />} />} />}
      footer={
        <div className="t-side-foot">
          {user && (
            <SideNavSection title="Account" isHeaderHidden>
              <SideNavItem label={user.name || user.email} icon={<UserAvatar picture={user.picture} />} />
            </SideNavSection>
          )}
          <button
            type="button"
            className={isSettingsPage(route.page) ? "t-settings selected" : "t-settings"}
            aria-label="Settings"
            title="Settings"
            aria-current={isSettingsPage(route.page) ? "page" : undefined}
            onClick={() => {
              navigate({ page: defaultSettingsPage(runners, user?.role) });
              close();
            }}
          >
            <Icon icon={Cog6ToothIcon} size="sm" />
          </button>
        </div>
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
        {online.length > 1 && (
          <Selector
            label="Filter by runner"
            isLabelHidden
            size="sm"
            options={[
              { value: "", label: "All runners" },
              ...online.map((r) => ({ value: r.id, label: r.name || r.id })),
            ]}
            value={activeRunner ?? ""}
            onChange={(val) => {
              setRunnerFilter(val || undefined);
              setShown(PAGE);
            }}
          />
        )}
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

      {pinned.length > 0 && (
        <>
          <div className="t-list-head">
            <span className="t-grow">Pinned</span>
          </div>
          <div className="t-rows">{pinned.map((r) => sessionRow(r))}</div>
        </>
      )}
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
        {rest.length === 0 && <div className="t-empty-line">{q ? "No sessions match." : !online.length ? "No runner connected." : pinned.length ? "No other recent sessions." : "No sessions yet."}</div>}
        {(() => {
          const groups = recentGroups(rest.slice(0, shown), { query: q, filter });
          if (!groups) return rest.slice(0, shown).map((r) => sessionRow(r));
          return groups.map((g) => (
              <Fragment key={g.path}>
                <button
                  type="button"
                  className="t-group-head"
                  title={g.path}
                  aria-label={`Project ${g.label}: show all its sessions`}
                  onClick={() => {
                    useStore.setState({ projectFilter: g.path });
                    setShown(PAGE);
                  }}
                >
                  {g.label}
                </button>
                {g.rows.map((r) => sessionRow(r, true))}
              </Fragment>
            ));
        })()}
        {rest.length > shown && (
          <button type="button" className="t-more" onClick={() => setShown(shown + PAGE)}>
            Show more
          </button>
        )}
      </div>
      {/* An open session not in the list above (a subagent, started session, or one further down): its children. */}
      {selected && !selectedRow && children.length > 0 && (
        <>
          <div className="t-list-head">
            <span className="t-grow">{children.every((c) => c.spawned) ? "Started by this session" : "Subagents of this session"}</span>
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
    <SidebarHandle />
    </div>
  );
}

/** Deeper nesting (subagents or depth-2 started sessions under an active nested child). */
function NestedBranch({ runnerId, parentId, activeChain, selectedId, now }: { runnerId: string; parentId: string; activeChain: string[]; selectedId: string; now: number }) {
  const children = useChildren(runnerId, parentId);
  const activeId = activeChain[0];
  const [toggled, setToggled] = useState<boolean>();
  const open = childrenOpen(false, children, activeId, toggled);
  if (!children.length) return null;
  const { label, running, said } = childrenToggle(children);
  const { few, rest } = fewChildren(children, activeId, CHILD_ROWS);
  return (
    <div className="t-child-nested">
      <button type="button" className="t-child-toggle" aria-expanded={open} aria-label={said} title={said} onClick={() => setToggled(!open)}>
        <span className="t-child-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="t-child-label">{label}</span>
        {running > 0 && (
          <span className="t-child-running" aria-hidden="true">
            <StatusDot status="running" />
            {running}
          </span>
        )}
      </button>
      {open && (
        <>
          {few.map((c) => (
            <Fragment key={c.id}>
              <SessionRow row={c} now={now} selected={c.id === selectedId} child />
              {c.id === activeId && activeChain.length > 1 && (
                <NestedBranch runnerId={runnerId} parentId={c.id} activeChain={activeChain.slice(1)} selectedId={selectedId} now={now} />
              )}
            </Fragment>
          ))}
          {rest.length > 0 && (
            <SubagentsPopover
              runnerId={runnerId}
              children={children}
              onPick={() => useStore.setState({ sidebarOpen: false })}
              trigger={
                <button type="button" className="t-more t-child-more">
                  {moreLabel(rest)}
                </button>
              }
            />
          )}
        </>
      )}
    </div>
  );
}

/** The Foliation profile picture, round, at the icon's size; else the user icon exactly as before. */
function UserAvatar({ picture }: { picture?: string }) {
  const [failed, setFailed] = useState<string>();
  const src = avatarSrc(picture, failed);
  if (!src) return <Icon icon={UserCircleIcon} size="sm" color="secondary" />;
  return <img className="t-avatar" src={src} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(src)} />;
}
