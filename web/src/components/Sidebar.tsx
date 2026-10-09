import { useEffect, useRef, useState } from "react";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Item } from "@astryxdesign/core/Item";
import { Kbd } from "@astryxdesign/core/Kbd";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Selector } from "@astryxdesign/core/Selector";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import {
  ChevronDoubleLeftIcon,
  Cog6ToothIcon,
  MagnifyingGlassIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import type { ProjectInfo, SessionSearchResult, SessionSummary } from "../shared/protocol";
import { act, rpc, selectSession, switchRunner, toggleProject, toggleSidebar, useStore } from "../store";
import { ago } from "../util";
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

  return (
    <SideNav
      header={
        <SideNavHeading
          heading="Tether"
          headerEndContent={
            <HStack gap={0.5} vAlign="center">
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
      footer={
        <HStack gap={2} vAlign="center">
          <Avatar name={user?.name || user?.email || "?"} size="sm" />
          <Text type="supporting" maxLines={1}>
            {user?.name || user?.email}
          </Text>
        </HStack>
      }
      footerIcons={<IconButton label="Settings" tooltip="Settings" variant="ghost" icon={<Icon icon={Cog6ToothIcon} />} onClick={() => useStore.setState({ dialog: "settings" })} />}
    >
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
        <LiveSection />
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
    </SideNav>
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

/** Every session with a running agent process, across projects, newest first. */
function LiveSection() {
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  // Loaded summaries are pushed live by the runner, so they win over the listProjects snapshot.
  const by = new Map(projects.flatMap((p) => p.live.map((s) => [s.id, s] as const)));
  for (const s of Object.values(sessions).flat()) if (s.live || by.has(s.id)) by.set(s.id, s);
  const rows = [...by.values()].filter((s) => s.live).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!rows.length) return null;
  return (
    <SideNavSection title="Live">
      {rows.map((s) => (
        <SessionRow key={s.id} s={s} />
      ))}
    </SideNavSection>
  );
}

function ProjectRow({ p, open }: { p: ProjectInfo; open: boolean }) {
  const loaded = useStore((s) => s.sessions[p.path]);
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
    // Live sessions first, archived last, most recent first within each.
    const rank = (s: SessionSummary) => (s.live ? 0 : s.archived ? 2 : 1);
    const sorted = [...loaded].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
    rows = all ? sorted : sorted.slice(0, SHOW);
    if (sorted.length > SHOW) more = <SideNavItem size="sm" label={all ? "Show fewer" : `Show all ${sorted.length}`} onClick={() => setAll(!all)} />;
    if (!sorted.length) more = <SideNavItem size="sm" label="No sessions" isDisabled />;
  } else more = <SideNavItem size="sm" label="Loading…" isDisabled />;

  return (
    <SideNavItem
      label={p.name}
      collapsible={{ isCollapsed: !open, onCollapsedChange: (collapsed) => toggleProject(p.path, !collapsed) }}
      onClick={() => toggleProject(p.path)}
      endContent={p.sessionCount ? <Text type="supporting">{p.sessionCount}</Text> : undefined}
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

const noticeLabel = (kind: string) => (kind === "finished" ? "Completed" : kind === "question" ? "Question" : "Blocked");

function SessionIndicator({ s }: { s: SessionSummary }) {
  const notice = useStore((st) => st.notices.find((n) => n.sessionId === s.id));
  const read = useStore((st) => (notice ? notice.ts <= st.noticesSeen || st.noticesRead.includes(notice.id) : false));
  if (notice)
    return (
      <StatusDot
        variant={notice.kind === "finished" ? "success" : "error"}
        isPulsing={!read}
        label={`${noticeLabel(notice.kind)}, ${read ? "viewed" : "ready to view"}`}
        tooltip={`${noticeLabel(notice.kind)} · ${read ? "Viewed" : "Ready to view"}`}
      />
    );
  if (s.needsInput) return <StatusDot variant="warning" isPulsing label="Needs your input" tooltip="Needs your input" />;
  if (s.status === "running") return <Spinner size="sm" aria-label="Running" />;
  if (s.status === "waiting") return <StatusDot variant="warning" label="Waiting" tooltip="Waiting (usage limit or retry)" />;
  if (s.live) return <StatusDot variant="accent" label="Live" tooltip="Live" />;
  return null;
}

function SessionRow({ s }: { s: SessionSummary }) {
  const [editing, setEditing] = useState(false);
  const sel = useStore((st) => st.selected === s.id);
  if (editing) return <RenameInput session={s} onDone={() => setEditing(false)} />;
  return (
    <SideNavItem
      label={s.title}
      size="sm"
      isSelected={sel}
      onClick={() => selectSession(s.id)}
      endContent={
        <HStack gap={1} vAlign="center">
          <SessionIndicator s={s} />
          <HarnessBadge harness={s.harness} />
          {!s.live && <Text type="supporting">{ago(s.updatedAt)}</Text>}
        </HStack>
      }
      actions={
        <MoreMenu
          label="Session options"
          size="sm"
          alignment="end"
          items={[
            { label: "Rename", onClick: () => setEditing(true) },
            ...(s.status === "idle" ? [{ label: s.archived ? "Unarchive" : "Archive", onClick: () => archive(s, !s.archived) }] : []),
            ...(s.live && s.status === "idle" ? [{ label: "Stop the agent process", onClick: () => act("closeSession", { sessionId: s.id }) }] : []),
          ]}
        />
      }
    />
  );
}
