import { useEffect, useRef, useState } from "react";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useContainerReveal } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Item } from "@astryxdesign/core/Item";
import { Kbd } from "@astryxdesign/core/Kbd";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Selector } from "@astryxdesign/core/Selector";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import {
  BoltIcon,
  BookOpenIcon,
  ChevronDoubleLeftIcon,
  Cog6ToothIcon,
  HomeIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { byRecent, type ProjectInfo, type SessionSearchResult, type SessionSummary } from "../shared/protocol";
import { act, goHome, openPage, rpc, selectSession, switchRunner, toggleProject, toggleSidebar, useStore } from "../store";
import { allowTrashClick, holdTrashUntilMove, useTrashHeld } from "../trashGuard";
import { ago } from "../util";
import { runningCount } from "../dashboard";
import { HarnessBadge } from "./HarnessBadge";
import { NoticeBell } from "./Notices";

const SHOW = 8;

/** `narrow`: shown as the phone drawer, which has its own close button. */
export function Sidebar({ narrow }: { narrow?: boolean }) {
  const runners = useStore((s) => s.runners);
  const runnerId = useStore((s) => s.runnerId);
  const allProjects = useStore((s) => s.projects);
  const [showArchived, setShowArchived] = useState(false);
  const projects = allProjects.filter((p) => !p.archived);
  const archivedProjects = allProjects.filter((p) => p.archived);
  const expanded = useStore((s) => s.expanded);
  const user = useStore((s) => s.user);
  const loaded = useStore((s) => s.projectsLoaded);
  const online = runners.filter((r) => r.connected);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SessionSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const searchRequest = useRef(0);
  const q = query.trim();

  useEffect(() => {
    const request = ++searchRequest.current;
    if (q.length < 2) {
      setSearchResults([]);
      setSearching(false);
      setSearchError("");
      return;
    }
    setSearching(true);
    setSearchError("");
    const timer = setTimeout(() => {
      rpc("searchSessions", { query: q })
        .then((results) => {
          if (searchRequest.current === request) setSearchResults(results);
        })
        .catch(() => {
          if (searchRequest.current === request) setSearchError("Could not search sessions. Check that the runner is connected.");
        })
        .finally(() => {
          if (searchRequest.current === request) setSearching(false);
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [q]);

  // Ctrl/Cmd+K: search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const footer = (
    <HStack gap={2} vAlign="center" width="100%">
      <Avatar name={user?.name || user?.email || "?"} size="sm" />
      <StackItem size="fill">
        <Text type="supporting" maxLines={1}>
          {user?.name || user?.email}
        </Text>
      </StackItem>
      <IconButton label="Settings" tooltip="Settings" variant="ghost" size="sm" icon={<Icon icon={Cog6ToothIcon} />} onClick={() => useStore.setState({ dialog: "settings" })} />
    </HStack>
  );

  return (
    <SideNav
      // As a phone drawer, always slide in from the left, where the menu button is. Astryx's "auto"
      // guesses from the focused element, and iOS doesn't focus a tapped button, so it picked the right.
      {...({ side: "start" } as {})}
      header={
        <SideNavHeading
          heading="Tether"
          headerEndContent={
            <HStack gap={0.5} vAlign="center">
              <IconButton label="Home" tooltip="Home: everything running and waiting on you" variant="ghost" size="sm" icon={<Icon icon={HomeIcon} />} onClick={goHome} />
              <NoticeBell />
              {!narrow && (
                <IconButton label="Hide sidebar" tooltip="Hide sidebar (⌘B)" variant="ghost" size="sm" icon={<Icon icon={ChevronDoubleLeftIcon} />} onClick={toggleSidebar} />
              )}
            </HStack>
          }
        />
      }
      topContent={
        <VStack gap={2}>
          <Button
            label="New session"
            variant="secondary"
            width="100%"
            icon={<Icon icon={PlusIcon} />}
            tooltip="New session (⇧⌘O)"
            onClick={() => useStore.setState({ dialog: "new", newSessionProject: undefined })}
          />
          <TextInput
            ref={searchInput}
            label="Search your messages"
            isLabelHidden
            size="sm"
            placeholder="Search  ⌘K"
            startIcon={MagnifyingGlassIcon}
            hasClear
            value={query}
            onChange={setQuery}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          />
          {online.length > 1 && (
            <Selector label="Runner" isLabelHidden size="sm" value={runnerId ?? ""} options={online.map((r) => ({ value: r.id, label: r.id }))} onChange={(v) => v && switchRunner(v)} />
          )}
        </VStack>
      }
      // The desktop sidebar keeps its footer pinned; the drawer would put it after the list, so there it's ours.
      footer={narrow ? undefined : footer}
    >
      <DrawerBody footer={narrow ? footer : undefined}>
      {q ? (
        <SideNavSection title="Search results">
          {q.length < 2 ? (
            <Text type="supporting">Type at least two characters to search.</Text>
          ) : searching ? (
            <Spinner size="sm" label="Searching session messages…" />
          ) : searchError ? (
            <Text type="supporting">{searchError}</Text>
          ) : searchResults.length ? (
            searchResults.map((r) => <SearchHit key={r.session.id} result={r} />)
          ) : (
            <Text type="supporting">No sessions mention “{q}”.</Text>
          )}
        </SideNavSection>
      ) : (
        <>
        <RunningItem />
        <MemoryNavItem />
        <NeedsYouSection />
        <SideNavSection
          title="Projects"
          endContent={<IconButton label="Add project" tooltip="Add project" variant="ghost" size="sm" icon={<Icon icon={PlusIcon} />} onClick={() => useStore.setState({ dialog: "addProject" })} />}
        >
          {projects.map((p) => (
            <ProjectRow key={p.path} p={p} open={!!expanded[p.path]} />
          ))}
          {runnerId && projects.length === 0 && (
            <EmptyState isCompact title={loaded ? "No projects yet" : "Loading projects…"} description={loaded ? "Add one with +." : undefined} />
          )}
          {archivedProjects.length > 0 && (
            <SideNavItem
              label={showArchived ? "Hide archived projects" : `Archived projects (${archivedProjects.length})`}
              size="sm"
              onClick={() => setShowArchived(!showArchived)}
            />
          )}
          {showArchived && archivedProjects.map((p) => <ProjectRow key={p.path} p={p} open={!!expanded[p.path]} />)}
        </SideNavSection>
        </>
      )}
      </DrawerBody>
    </SideNav>
  );
}

/**
 * In the phone drawer, the list scrolls inside Astryx's drawer body and its footer slot sits after the
 * list, so it scrolls away. Here the footer sticks to the bottom of that scroll area instead (and sits
 * at the bottom when the list is short).
 */
function DrawerBody({ footer, children }: { footer?: React.ReactNode; children: React.ReactNode }) {
  if (!footer) return <>{children}</>;
  return (
    <VStack style={{ minHeight: "100%" }}>
      <StackItem size="fill">{children}</StackItem>
      <VStack
        paddingBlockStart={2}
        style={{
          // Clear of the home indicator in the installed app.
          paddingBlockEnd: "calc(var(--spacing-2) + env(safe-area-inset-bottom))",
          position: "sticky",
          // Down over the drawer body's own bottom padding, flush with the edge.
          bottom: "calc(-1 * var(--spacing-2))",
          marginBlockEnd: "calc(-1 * var(--spacing-2))",
          background: "var(--color-background-surface)",
          borderBlockStart: "var(--border-width) solid var(--color-border)",
          zIndex: 1,
        }}
      >
        {footer}
      </VStack>
    </VStack>
  );
}

function SearchHit({ result }: { result: SessionSearchResult }) {
  const { session } = result;
  const selected = useStore((s) => s.selected === session.id);
  return (
    <Item
      density="compact"
      isSelected={selected}
      startContent={<HarnessBadge harness={session.harness} />}
      label={session.title}
      labelLines={1}
      description={`${session.projectPath.split(/[\\/]/).filter(Boolean).slice(-1)[0] || session.projectPath} · ${result.excerpt}`}
      descriptionLines={2}
      endContent={<Text type="supporting">{ago(session.updatedAt)}</Text>}
      onClick={() => {
        useStore.setState((state) => ({
          sessions: {
            ...state.sessions,
            [session.projectPath]: [...(state.sessions[session.projectPath] ?? []).filter((item) => item.id !== session.id), session],
          },
        }));
        selectSession(session.id);
      }}
    />
  );
}

/** Every session we know a summary for. Loaded summaries are pushed live by the runner, so they win over the listProjects snapshot. */
function knownSessions(projects: ProjectInfo[], sessions: Record<string, SessionSummary[]>) {
  const by = new Map(projects.flatMap((p) => p.live.map((s) => [s.id, s] as const)));
  for (const s of Object.values(sessions).flat()) by.set(s.id, s);
  return by;
}

type Attention = { kind: "finished" | "blocked"; read: boolean };

/** Whether a session is waiting on you: finished (green) or blocked (red), and whether you've looked since. */
type NoticeState = Pick<ReturnType<typeof useStore.getState>, "notices" | "noticesSeen" | "noticesRead">;
function attentionOf(st: NoticeState, s: SessionSummary): Attention | undefined {
  const notice = st.notices.find((n) => n.sessionId === s.id);
  const read = !!notice && (notice.ts <= st.noticesSeen || st.noticesRead.includes(notice.id));
  if (s.needsInput) return { kind: "blocked", read: notice?.kind !== "finished" && read };
  // A running agent has moved past whatever its last notice said.
  if (!notice || s.status === "running" || s.status === "waiting") return undefined;
  return { kind: notice.kind === "finished" ? "finished" : "blocked", read };
}

/** The Memory & Skills page; the count is open memory conflicts. */
function MemoryNavItem() {
  const on = useStore((s) => s.page === "memory");
  const open = useStore((s) => s.conflicts.length);
  return (
    <SideNavItem
      label="Memory & Skills"
      icon={BookOpenIcon}
      isSelected={on}
      onClick={() => openPage("memory")}
      endContent={open ? <Badge variant="warning" label={String(open)} /> : undefined}
    />
  );
}

/** Open memory conflicts: open the session that produced one (its card is inline there), else the page. */
function ConflictRows() {
  const conflicts = useStore((s) => s.conflicts);
  return (
    <>
      {conflicts.map((c) => (
        <SideNavItem
          key={c.id}
          size="sm"
          label={`Merged memory: ${c.name}`}
          endContent={<StatusDot variant="warning" label="Conflicting memory" tooltip="A new memory contradicted an old one. The new one is in use." />}
          onClick={() => (c.sessionId ? selectSession(c.sessionId) : openPage("memory", "conflicts"))}
        />
      ))}
    </>
  );
}

/**
 * Sessions that need you, grouped by project. Unread ones leave once you've opened them and moved on;
 * blocked ones stay until the agent is unblocked.
 */
function NeedsYouSection() {
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const notices = useStore((s) => s.notices);
  const selected = useStore((s) => s.selected);
  const noticesRead = useStore((s) => s.noticesRead);
  const noticesSeen = useStore((s) => s.noticesSeen);
  const conflicts = useStore((s) => s.conflicts.length);
  const shown = useRef(new Set<string>());

  const by = knownSessions(projects, sessions);
  // A notice for a session we have no summary for yet (its project is collapsed): enough to show and open it.
  for (const n of notices)
    if (!by.has(n.sessionId))
      by.set(n.sessionId, {
        id: n.sessionId,
        harness: n.sessionId.split(":")[0] as SessionSummary["harness"],
        nativeId: n.sessionId.split(":").slice(1).join(":"),
        projectPath: n.projectPath,
        title: n.title.split(" · ").slice(1).join(" · ") || n.title,
        createdAt: n.ts,
        updatedAt: n.ts,
        live: false,
        status: "idle",
      });

  const st = { notices, noticesRead, noticesSeen };
  const rows = [...by.values()].filter((s) => {
    if (s.archived) return false;
    const a = attentionOf(st, s);
    if (a && (a.kind === "blocked" || !a.read)) return true;
    // Stay put while you're looking at it, so the list doesn't jump under you.
    return !!a && s.id === selected && shown.current.has(s.id);
  });
  shown.current = new Set(rows.map((s) => s.id));
  if (!rows.length && !conflicts) return null;

  const groups = new Map<string, SessionSummary[]>();
  for (const s of rows.sort(byRecent)) groups.set(s.projectPath, [...(groups.get(s.projectPath) ?? []), s]);
  return (
    <SideNavSection title="Needs you">
      <ConflictRows />
      {[...groups].map(([path, list]) => (
        <SideNavItem key={path} label={projects.find((p) => p.path === path)?.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path} size="sm">
          {list.map((s) => (
            <SessionRow key={s.id} s={s} />
          ))}
        </SideNavItem>
      ))}
    </SideNavSection>
  );
}

function ProjectRow({ p, open }: { p: ProjectInfo; open: boolean }) {
  const loaded = useStore((s) => s.sessions[p.path]);
  const running = useStore((s) => [...knownSessions(s.projects, s.sessions).values()].filter((x) => x.projectPath === p.path && x.status === "running").length);
  const [all, setAll] = useState(false);
  const archiveProject = async (archived: boolean) => {
    if (archived && p.live.some((s) => s.status !== "idle") && !confirm(`${p.name} has a running session. Archive the project anyway? The session keeps running.`))
      return;
    if ((await act("archiveProject", { path: p.path, archived })) === undefined) return;
    useStore.setState((st) => ({ projects: st.projects.map((x) => (x.path === p.path ? { ...x, archived } : x)) }));
  };

  let rows: SessionSummary[] = [];
  let more: React.ReactNode = null;
  if (!open) more = <SideNavItem size="sm" label="Loading…" isDisabled />;
  else if (loaded) {
    // Most recent message first, live or not. Sessions marked done never show here; search finds
    // them, and sending one a message brings it back.
    const sorted = loaded.filter((s) => !s.archived).sort(byRecent);
    rows = all ? sorted : sorted.slice(0, SHOW);
    more = sorted.length > SHOW && <SideNavItem size="sm" label={all ? "Show fewer" : `Show all ${sorted.length}`} onClick={() => setAll(!all)} />;
    if (!sorted.length) more = <SideNavItem size="sm" label="No sessions" isDisabled />;
  } else more = <SideNavItem size="sm" label="Loading…" isDisabled />;

  return (
    <SideNavItem
      label={p.name}
      collapsible={{ isCollapsed: !open, onCollapsedChange: (collapsed) => toggleProject(p.path, !collapsed) }}
      onClick={() => toggleProject(p.path)}
      endContent={
        <HStack gap={1} vAlign="center">
          {!open && running > 0 && <Spinner size="sm" aria-label={`${running} running`} />}
          {p.sessionCount ? <Text type="supporting">{p.sessionCount}</Text> : null}
        </HStack>
      }
      actions={
        <>
          {!p.archived && (
            <IconButton
              label={`New session in ${p.name}`}
              tooltip={`New session in ${p.name}`}
              variant="ghost"
              icon={<Icon icon={PlusIcon} />}
              onClick={() => useStore.setState({ dialog: "new", newSessionProject: p.path })}
            />
          )}
          <MoreMenu
            label={`${p.name} options`}
            size="sm"
            alignment="end"
            items={[{ label: p.archived ? "Unarchive project" : "Archive project", onClick: () => archiveProject(!p.archived) }]}
          />
        </>
      }
    >
      {rows.map((s) => (
        <SessionRow key={s.id} s={s} />
      ))}
      {more}
    </SideNavItem>
  );
}

export async function archive(s: SessionSummary, archived: boolean) {
  const r = await act("archiveSession", { sessionId: s.id, archived });
  if (r === undefined) return;
  useStore.setState((st) => ({
    sessions: { ...st.sessions, [s.projectPath]: (st.sessions[s.projectPath] ?? []).map((x) => (x.id === s.id ? { ...x, archived } : x)) },
  }));
  if (archived && useStore.getState().selected === s.id) selectSession(undefined);
}

/** The row's trash button: stops the agent process and archives the session in one go, no confirm. */
export async function removeSession(s: SessionSummary) {
  if ((await act("removeSession", { sessionId: s.id })) === undefined) return;
  useStore.setState((st) => {
    const list = st.sessions[s.projectPath] ?? [];
    const gone = { ...(list.find((x) => x.id === s.id) ?? s), archived: true, live: false, status: "idle" as const, needsInput: false };
    return {
      sessions: { ...st.sessions, [s.projectPath]: list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? gone : x)) : [...list, gone] },
      projects: st.projects.map((p) => (p.path === s.projectPath ? { ...p, live: p.live.filter((x) => x.id !== s.id) } : p)),
      // The runner forgets them too, so a removed session never comes back as needing you.
      notices: st.notices.filter((n) => n.sessionId !== s.id),
    };
  });
  if (useStore.getState().selected === s.id) selectSession(undefined);
}

/** Inline title editor: Enter or leaving the field saves, Escape cancels, empty restores the harness title. */
function RenameInput({ session, onDone }: { session: SessionSummary; onDone: () => void }) {
  const [title, setTitle] = useState(session.title);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const t = title.trim();
    if (save && t !== session.title) act("renameSession", { sessionId: session.id, projectPath: session.projectPath, title: t });
    onDone();
  };
  return (
    <TextInput
      label="Session name"
      isLabelHidden
      size="sm"
      hasAutoFocus
      value={title}
      placeholder="Empty: use the harness title"
      onChange={setTitle}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      }}
    />
  );
}

/** Home's Running section, with its count: sessions doing something now on every runner. */
function RunningItem() {
  const page = useStore((s) => s.page);
  const n = useStore((s) => runningCount(s.pulses));
  return (
    <SideNavItem
      label="Running"
      icon={BoltIcon}
      isSelected={page === "running"}
      onClick={() => openPage("running")}
      endContent={n > 0 ? <Badge label={n} variant="info" /> : undefined}
    />
  );
}

/** Subagents, shells and the like a live session has going, as a count. */
function ActivityCount({ s }: { s: SessionSummary }) {
  if (!s.live || !s.activeCount) return null;
  return (
    <Tooltip content={`${s.activeCount} running: subagents, shells, monitors or wakeups`}>
      <Badge label={s.activeCount} />
    </Tooltip>
  );
}

function SessionIndicator({ s }: { s: SessionSummary }) {
  const kind = useStore((st) => attentionOf(st, s)?.kind);
  const read = useStore((st) => attentionOf(st, s)?.read);
  if (kind) {
    const what = kind === "finished" ? "Finished" : "Needs your input";
    const color = kind === "finished" ? "success" : "error";
    return (
      <StatusDot
        variant={color}
        label={`${what}, ${read ? "viewed" : "not viewed yet"}`}
        tooltip={`${what} · ${read ? "Viewed" : "Not viewed yet"}`}
        // Viewed: a ring instead of a filled dot.
        style={read ? { background: "transparent", boxShadow: `inset 0 0 0 calc(var(--border-width) * 2) var(--color-${color})` } : undefined}
      />
    );
  }
  if (s.status === "running") return <Spinner size="sm" aria-label="Running" />;
  if (s.status === "waiting") return <StatusDot variant="warning" label="Waiting" tooltip="Waiting (usage limit or retry)" />;
  if (s.live) return <StatusDot variant="accent" label="Live" tooltip="Live" />;
  return null;
}

function SessionRow({ s }: { s: SessionSummary }) {
  const [editing, setEditing] = useState(false);
  const sel = useStore((st) => st.selected === s.id);
  const [removing, setRemoving] = useState(false);
  // The trash button shows on hover or focus; touch screens (no hover) always show it.
  const { getContainerProps, getContentRevealProps } = useContainerReveal();
  // Not on a row that just slid under a still mouse after a removal (see trashGuard.ts).
  const held = useTrashHeld();
  if (editing) return <RenameInput session={s} onDone={() => setEditing(false)} />;
  const remove = s.archived ? null : (
    <IconButton
      {...getContentRevealProps({ forceVisibility: removing ? "shown" : undefined })}
      label={s.live ? "Done: stop and hide session" : "Done: hide session"}
      tooltip={s.live ? "Done: stop the agent and hide (search finds it)" : "Done: hide (search finds it)"}
      variant="ghost"
      size="sm"
      isLoading={removing}
      icon={<Icon icon={TrashIcon} />}
      onClick={(e) => {
        e.stopPropagation();
        if (!allowTrashClick(s.id, { x: e.clientX, y: e.clientY })) return;
        holdTrashUntilMove();
        setRemoving(true);
        removeSession(s).finally(() => setRemoving(false));
      }}
    />
  );
  return (
    <VStack {...getContainerProps({ forceState: removing ? "active" : held ? "inactive" : undefined })}>
    <SideNavItem
      label={s.title}
      size="sm"
      isSelected={sel}
      onClick={() => selectSession(s.id)}
      endContent={
        <HStack gap={1} vAlign="center">
          <ActivityCount s={s} />
          <SessionIndicator s={s} />
          <HarnessBadge harness={s.harness} />
          {!s.live && <Text type="supporting">{ago(s.updatedAt)}</Text>}
        </HStack>
      }
      actions={
        <>
          {remove}
          <MoreMenu
            label="Session options"
            size="sm"
            alignment="end"
            items={[
              { label: "Rename", onClick: () => setEditing(true) },
              ...(s.status === "idle" ? [{ label: s.archived ? "Bring back" : "Mark done", onClick: () => archive(s, !s.archived) }] : []),
              ...(s.live && s.status === "idle" ? [{ label: "Stop the agent process", onClick: () => act("closeSession", { sessionId: s.id }) }] : []),
            ]}
          />
        </>
      }
    />
    </VStack>
  );
}
