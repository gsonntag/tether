import { createContext, memo, use, useEffect, useMemo, useRef, useState } from "react";
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
import { BookOpenIcon, ChatBubbleLeftRightIcon, ChevronDoubleLeftIcon, Cog6ToothIcon, CpuChipIcon, HomeIcon, MagnifyingGlassIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { listPath, type ProjectInfo, type SessionSearchResult, type SessionSummary } from "../shared/protocol";
import { act, goHome, openLeader, openPage, rpc, selectSession, switchRunner, toggleProject, toggleSidebar, useStore } from "../store";
import { allowTrashClick, holdTrashUntilMove, useTrashHeld } from "../trashGuard";
import { ago } from "../util";
import { activityAt, byActivity, byListOrder, nestSubagents, projectIsQuiet, sessionState, showInSidebar, unreadNotice } from "../recentSessions";
import { blockingCount, knownSessions, useInbox, useMinute, useRecentContext, useSessionGroups } from "../sessionLists";
import { runningLine, summaryWork, workState, type WorkState } from "../workState";
import { HarnessBadge, HarnessGlyph } from "./HarnessBadge";
import { AgoWithAction, RowMenus, rowMenuKey, type RowMenuItems } from "./RowMenu";
import { NoticeBell } from "./Notices";
import { WorkIndicator } from "./WorkIndicator";

const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** A shortcut as this platform writes it: ⌘K / ⇧⌘O on a Mac, Ctrl+K / Ctrl+Shift+O elsewhere. */
export const keys = (key: string, shift = false) => (MAC ? `${shift ? "⇧" : ""}⌘${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`);

/** Rows a list shows before "Show more". */
const SHOW = 12;
/** A project's own list, when open. */
const SHOW_PROJECT = 8;

/** The session being renamed in place (from a double-click, or the row menu's Rename). */
const Renaming = createContext<{ id?: string; set: (id?: string) => void }>({ set: () => {} });

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
  const [renaming, setRenaming] = useState<string>();
  const renamingCtx = useMemo(() => ({ id: renaming, set: setRenaming }), [renaming]);
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
          // To Home (App.tsx reads "#/" as Home).
          headingHref="#/"
          headerEndContent={
            <HStack gap={0.5} vAlign="center">
              <NoticeBell />
              {!narrow && (
                <IconButton label="Hide sidebar" tooltip={`Hide sidebar (${keys("B")})`} variant="ghost" size="sm" icon={<Icon icon={ChevronDoubleLeftIcon} />} onClick={toggleSidebar} />
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
            tooltip={`New session (${keys("O", true)})`}
            onClick={() => useStore.setState({ dialog: "new", newSessionProject: undefined })}
          />
          <TextInput
            ref={searchInput}
            label="Search your messages"
            isLabelHidden
            size="sm"
            placeholder={`Search  ${keys("K")}`}
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
      <Renaming value={renamingCtx}>
      <RowMenus itemsFor={(id) => sessionMenu(id, searchResults, setRenaming)}>
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
        <HomeNavItem />
        <LeaderNavItem />
        <MemoryNavItem />
        <SessionsSection />
        <SideNavSection
          title="Projects"
          endContent={<IconButton label="Add project" tooltip="Add project" variant="ghost" size="sm" icon={<Icon icon={PlusIcon} />} onClick={() => useStore.setState({ dialog: "addProject" })} />}
        >
          <ProjectList projects={projects} expanded={expanded} />
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
      </RowMenus>
      </Renaming>
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
      {...rowMenuKey(session.id)}
      density="compact"
      isSelected={selected}
      startContent={<HarnessBadge harness={session.harness} />}
      label={session.title}
      labelLines={1}
      description={`${listPath(session).split(/[\\/]/).filter(Boolean).slice(-1)[0] || listPath(session)} · ${result.excerpt}`}
      descriptionLines={2}
      endContent={<Text type="supporting">{ago(session.updatedAt)}</Text>}
      onClick={() => {
        useStore.setState((state) => ({
          sessions: {
            ...state.sessions,
            [listPath(session)]: [...(state.sessions[listPath(session)] ?? []).filter((item) => item.id !== session.id), session],
          },
        }));
        selectSession(session.id);
      }}
    />
  );
}

/**
 * Home, the main page: the inbox of what waits on you, on every runner. Its red count is what an
 * agent is stalled on (approvals, questions, plans, blocked calls, memory conflicts); finished
 * turns don't count.
 */
function HomeNavItem() {
  const on = useStore((s) => !s.selected && s.page !== "memory");
  const g = useSessionGroups("all");
  const blocking = blockingCount(useInbox(g.needs));
  return (
    <SideNavItem
      label="Home"
      icon={HomeIcon}
      isSelected={on}
      onClick={goHome}
      endContent={
        blocking > 0 ? (
          <Tooltip content={`${blocking} waiting on you`}>
            <Badge label={blocking} variant="error" />
          </Tooltip>
        ) : undefined
      }
    />
  );
}

/**
 * The leader agent's chat (runner/src/leader.ts): one agent that follows every session and passes
 * on what you tell it. It isn't in the lists below (but for its own questions).
 */
function LeaderNavItem() {
  const on = useStore((s) => !!s.selected && !!s.open[s.selected]?.session?.leader);
  const working = useStore((s) => Object.values(s.sessions).some((list) => list.some((x) => x.leader && x.live && x.status === "running")));
  return (
    <SideNavItem
      label="Leader"
      icon={ChatBubbleLeftRightIcon}
      isSelected={on}
      onClick={openLeader}
      endContent={working ? <StatusDot variant="accent" isPulsing label="Working" /> : undefined}
    />
  );
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

/** A session row's menu (right-click, long-press): Rename, Mark done, Stop the agent process; a done one from search: Bring back. */
function sessionMenu(id: string, hits: SessionSearchResult[], rename: (id: string) => void): RowMenuItems | undefined {
  const st = useStore.getState();
  const s =
    st.open[id]?.session ??
    knownSessions(st.projects, st.sessions, st.recent).get(id) ??
    st.pulses[st.runnerId ?? ""]?.[id]?.session ??
    hits.find((h) => h.session.id === id)?.session;
  if (!s) return undefined;
  if (s.archived) return { title: s.title, items: [{ label: "Bring back", onClick: () => void archive(s, false) }] };
  return {
    title: s.title,
    items: [
      { label: "Rename", onClick: () => rename(s.id) },
      ...(s.status === "idle" ? [{ label: "Mark done", onClick: () => void archive(s, true) }] : []),
      ...(s.live && s.status === "idle" ? [{ label: "Stop the agent process", onClick: () => void act("closeSession", { sessionId: s.id }) }] : []),
    ],
  };
}

/**
 * Every session of this runner in one flat list, whatever its project: what needs you, what works
 * and what's recent, by the agent's latest activity (opening one doesn't move it). Its dot says
 * which need you (red) or finished since you looked (green).
 */
function SessionsSection() {
  const { needs, working, recent } = useSessionGroups("runner");
  const [all, setAll] = useState(false);
  const list = [...needs, ...working, ...recent].sort(byActivity);
  if (!list.length) return null;
  const asking = new Set(needs.map((e) => e.session.id));
  const at = new Map(list.map((e) => [e.session.id, activityAt(e.session, e.pulse)] as const));
  const rows = nestSubagents(list.map((e) => e.session));
  return (
    <SideNavSection title="Sessions">
      {(all ? rows : rows.slice(0, SHOW)).map(({ session: s, depth }) => (
        <SessionRow key={s.id} s={s} at={at.get(s.id)} depth={depth} withProject needsYou={asking.has(s.id)} />
      ))}
      {rows.length > SHOW && <SideNavItem size="sm" label={all ? "Show fewer" : "Show more"} onClick={() => setAll(!all)} />}
    </SideNavSection>
  );
}

/**
 * Projects by latest activity (pinned first), each collapsed until you open it. The quiet ones
 * (nothing in the window) fold under one row, unless you have them open.
 */
function ProjectList({ projects, expanded }: { projects: ProjectInfo[]; expanded: Record<string, boolean> }) {
  const sessions = useStore((s) => s.sessions);
  const ctx = useRecentContext();
  const [showQuiet, setShowQuiet] = useState(false);
  const sorted = [...projects].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  const quiet = new Set(sorted.filter((p) => !expanded[p.path] && projectIsQuiet(p, sessions[p.path], false, ctx)).map((p) => p.path));
  const active = sorted.filter((p) => !quiet.has(p.path));
  const folded = sorted.filter((p) => quiet.has(p.path));
  return (
    <>
      {active.map((p) => (
        <ProjectRow key={p.path} p={p} open={!!expanded[p.path]} />
      ))}
      {folded.length > 0 && (
        <SideNavItem
          size="sm"
          label={showQuiet ? "Hide quiet projects" : `${folded.length} quiet project${folded.length === 1 ? "" : "s"}`}
          onClick={() => setShowQuiet(!showQuiet)}
        />
      )}
      {showQuiet && folded.map((p) => <ProjectRow key={p.path} p={p} open={!!expanded[p.path]} />)}
    </>
  );
}

// Rows are memoized: the lists re-render on every click and status change, and each row is costly
// (menus, tooltips), so only the rows whose session changed are drawn again.
const ProjectRow = memo(function ProjectRow({ p, open }: { p: ProjectInfo; open: boolean }) {
  const loaded = useStore((s) => s.sessions[p.path]);
  // Collapsed, the row still says whether anything in it works: its main turns, or only background work.
  const countIn = (s: ReturnType<typeof useStore.getState>, state: WorkState) =>
    [...knownSessions(s.projects, s.sessions, s.recent).values()].filter((x) => listPath(x) === p.path && !x.archived && workState(summaryWork(x)) === state).length;
  const running = useStore((s) => countIn(s, "working"));
  const background = useStore((s) => countIn(s, "background"));
  const ctx = useRecentContext();
  const [all, setAll] = useState(false);
  // Built once per project and count: every click changes ctx and draws each project again, and
  // these (a tooltip, a menu) are most of a row's cost.
  const endContent = useMemo(
    () => (
      <HStack gap={1} vAlign="center">
        {!open && running > 0 && <Spinner size="sm" aria-label={`${running} working`} />}
        {!open && !running && background > 0 && (
          <Tooltip content={`${background} working in background`}>
            <Spinner size="sm" shade="subtle" aria-label={`${background} working in background`} />
          </Tooltip>
        )}
        {p.sessionCount ? <Text type="supporting">{p.sessionCount}</Text> : null}
      </HStack>
    ),
    [p, open, running, background],
  );
  const actions = useMemo(() => {
    const archiveProject = async (archived: boolean) => {
      if ((await act("archiveProject", { path: p.path, archived })) === undefined) return;
      useStore.setState((st) => ({ projects: st.projects.map((x) => (x.path === p.path ? { ...x, archived } : x)) }));
    };
    return (
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
    );
  }, [p]);

  // Only sessions touched recently (Settings → "Show sessions from the last"), plus any that are
  // working, need you or are open. Older and done ones aren't listed; search finds them, and
  // opening one or sending it a message makes it recent again.
  const visible = (loaded ?? p.live).filter((s) => showInSidebar(s, ctx)).sort(byListOrder);
  // Nothing to list: dimmed, still there to start a session in.
  const quiet = projectIsQuiet(p, loaded, open, ctx);

  let rows: SessionSummary[] = [];
  let more: React.ReactNode = null;
  if (!open || !loaded) more = <SideNavItem size="sm" label="Loading…" isDisabled />;
  else {
    // Most recently touched first, live or not.
    rows = all ? visible : visible.slice(0, SHOW_PROJECT);
    more = visible.length > SHOW_PROJECT && <SideNavItem size="sm" label={all ? "Show fewer" : `Show all ${visible.length}`} onClick={() => setAll(!all)} />;
    if (!visible.length) more = <SideNavItem size="sm" label={loaded.some((s) => !s.archived) ? "No recent sessions" : "No sessions"} isDisabled />;
  }

  return (
    <SideNavItem
      label={p.name}
      style={quiet ? { color: "var(--color-text-secondary)" } : undefined}
      collapsible={{ isCollapsed: !open, onCollapsedChange: (collapsed) => toggleProject(p.path, !collapsed, true) }}
      onClick={() => toggleProject(p.path, undefined, true)}
      endContent={endContent}
      actions={actions}
    >
      {nestSubagents(rows).map(({ session: s, depth }) => (
        <SessionRow key={s.id} s={s} depth={depth} />
      ))}
      {more}
    </SideNavItem>
  );
});

export async function archive(s: SessionSummary, archived: boolean) {
  const r = await act("archiveSession", { sessionId: s.id, archived });
  if (r === undefined) return;
  useStore.setState((st) => {
    // Added when only Recent knew it, so it leaves there too.
    const list = st.sessions[listPath(s)] ?? [];
    const next = { ...(list.find((x) => x.id === s.id) ?? s), archived };
    return { sessions: { ...st.sessions, [listPath(s)]: list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? next : x)) : [...list, next] } };
  });
  if (archived && useStore.getState().selected === s.id) selectSession(undefined);
}

/** The row's trash button: stops the agent process and archives the session in one go, no confirm. */
export async function removeSession(s: SessionSummary) {
  if ((await act("removeSession", { sessionId: s.id })) === undefined) return;
  useStore.setState((st) => {
    const list = st.sessions[listPath(s)] ?? [];
    const gone = { ...(list.find((x) => x.id === s.id) ?? s), archived: true, live: false, status: "idle" as const, needsInput: false };
    return {
      sessions: { ...st.sessions, [listPath(s)]: list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? gone : x)) : [...list, gone] },
      projects: st.projects.map((p) => (p.path === listPath(s) ? { ...p, live: p.live.filter((x) => x.id !== s.id) } : p)),
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

/** Subagents, shells and the like a live session has going, as a count. */
function ActivityCount({ s }: { s: SessionSummary }) {
  if (!s.live || !s.activeCount) return null;
  const w = summaryWork(s);
  const tip = [runningLine(w.running) && `${runningLine(w.running)} running`, w.armed && `${w.armed} scheduled`].filter(Boolean).join(" · ");
  return (
    <Tooltip content={tip}>
      <Badge label={s.activeCount} />
    </Tooltip>
  );
}

/** Needs you: red for a question or a problem, green for a finished turn you haven't opened. Else how it's working, if it is. */
/** `needsYou`: in Needs you, where an open one keeps its dot until you leave it (it's read by then). */
function SessionIndicator({ s, needsYou }: { s: SessionSummary; needsYou?: boolean }) {
  const need = useStore((st) =>
    s.live && s.needsInput
      ? "asking"
      : sessionState(s, st) === "needs"
        ? unreadNotice(s, st)?.kind
        : needsYou
          ? (st.notices.find((n) => n.sessionId === s.id)?.kind ?? "blocked")
          : undefined,
  );
  if (need === "finished") return <StatusDot variant="success" label="Finished" tooltip="Finished · not opened yet" />;
  if (need) return <StatusDot variant="error" label={need === "blocked" ? "Blocked" : "Needs you"} tooltip={need === "asking" ? "Needs you · waiting for your answer" : need === "blocked" ? "Blocked · not opened yet" : "Needs you · not opened yet"} />;
  return <WorkIndicator work={summaryWork(s)} />;
}

const projectName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/**
 * A session in the sidebar, two lines: the title at full width with its state at the end; then
 * its harness, its project (`withProject`: in the flat list) and how long since the agent was
 * active, which the trash button covers on hover. Right-click or long-press: Rename, Mark done,
 * Stop the agent process (RowMenus). Double-click renames.
 */
const SessionRow = memo(function SessionRow({ s, at, withProject, needsYou, depth = 0 }: { s: SessionSummary; at?: number; withProject?: boolean; needsYou?: boolean; depth?: number }) {
  // Memoized, the row redraws on its own each minute so "ago" moves on.
  useMinute();
  const renaming = use(Renaming);
  const editing = renaming.id === s.id;
  const sel = useStore((st) => st.selected === s.id);
  const [removing, setRemoving] = useState(false);
  // The trash button shows on hover or focus; touch screens (no hover) always show it.
  const reveal = useContainerReveal();
  // Not on a row that just slid under a still mouse after a removal (see trashGuard.ts).
  const held = useTrashHeld();
  if (editing) return <RenameInput session={s} onDone={() => renaming.set(undefined)} />;
  const trash = s.archived ? undefined : (
    <IconButton
      label={s.live ? "Stop and remove" : "Remove"}
      tooltip={s.live ? "Stop the agent and remove (search finds it)" : "Remove (search finds it)"}
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
  const project = withProject ? projectName(listPath(s)) : undefined;
  return (
    <Item
      {...rowMenuKey(s.id)}
      {...reveal.getContainerProps({ forceState: removing ? "active" : held ? "inactive" : undefined })}
      density="compact"
      isSelected={sel}
      labelLines={1}
      label={s.title}
      // A subagent sits under the session that started it.
      style={depth ? { marginInlineStart: `calc(var(--spacing-3) * ${Math.min(depth, 3)})` } : undefined}
      // Double-click renames.
      onClick={(e) => (e.detail === 2 ? renaming.set(s.id) : selectSession(s.id))}
      description={
        <HStack gap={1} vAlign="center">
          {s.startedBy && (
            <Tooltip content={`Subagent "${s.startedBy.name}", started by ${s.startedBy.title ? `“${s.startedBy.title}”` : "another session"}`}>
              <Icon icon={CpuChipIcon} size="xsm" color="secondary" />
            </Tooltip>
          )}
          {s.createdBy && (
            <Tooltip content="Started by your leader, at your request">
              <Icon icon={ChatBubbleLeftRightIcon} size="xsm" color="secondary" />
            </Tooltip>
          )}
          <HarnessGlyph harness={s.harness} />
          {project && (
            <Text type="supporting" maxLines={1}>
              {project}
            </Text>
          )}
        </HStack>
      }
      endContent={
        <VStack gap={0} hAlign="end">
          <HStack gap={1} vAlign="center" style={{ minHeight: "var(--spacing-5)" }}>
            <ActivityCount s={s} />
            <SessionIndicator s={s} needsYou={needsYou} />
          </HStack>
          <AgoWithAction
            reveal={reveal}
            isShown={removing}
            ago={
              <Text type="supporting" hasTabularNumbers>
                {ago(at ?? s.updatedAt)}
              </Text>
            }
            action={trash}
          />
        </VStack>
      }
    />
  );
});
