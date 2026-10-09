import { useEffect, useRef, useState } from "react";
import type { ProjectInfo, SessionSearchResult, SessionSummary } from "../shared/protocol";
import { act, requestNotifications, rpc, selectSession, switchRunner, toggleProject, useStore } from "../store";
import { NoticeBell } from "./Notices";
import { ago, badge } from "../util";
import { UsagePanel } from "./Usage";

const SHOW = 8;

export function Sidebar() {
  const runners = useStore((s) => s.runners);
  const runnerId = useStore((s) => s.runnerId);
  const allProjects = useStore((s) => s.projects);
  const [showArchived, setShowArchived] = useState(false);
  const projects = allProjects.filter((p) => !p.archived);
  const archivedProjects = allProjects.filter((p) => p.archived);
  const expanded = useStore((s) => s.expanded);
  const user = useStore((s) => s.user);
  const loaded = useStore((s) => s.projectsLoaded);
  const selected = useStore((s) => s.selected);
  const online = runners.filter((r) => r.connected);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SessionSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const searchRequest = useRef(0);

  useEffect(() => {
    const q = query.trim();
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
  }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <aside className="side">
      <div className="brand">
        Tether
        <NoticeBell />
        <span className="runner" title="Runner (the machine your agents run on)">
          <span className={`dot${runnerId ? "" : " off"}`} />
          {online.length > 1 ? (
            <select
              value={runnerId}
              onChange={(e) => switchRunner(e.target.value)}
            >
              {online.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id}
                </option>
              ))}
            </select>
          ) : (
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{runnerId ?? "offline"}</span>
          )}
        </span>
      </div>
      <button
        className="newbtn"
        onClick={() => {
          requestNotifications();
          useStore.setState({ dialog: "new", newSessionProject: undefined });
        }}
      >
        ＋ New session
        <span className="grow" />
        <span style={{ fontSize: 11, color: "var(--dim)" }}>⌘K</span>
      </button>
      <div className="session-search">
        <span aria-hidden="true">⌕</span>
        <input
          ref={searchInput}
          type="search"
          value={query}
          placeholder="Search your messages"
          aria-label="Search your session messages"
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && <button className="search-clear" aria-label="Clear search" onClick={() => setQuery("")}>×</button>}
        <kbd>⇧⌘F</kbd>
      </div>
      <div className="sec">
        <span>{query.trim() ? "Search results" : "Projects"}</span>
        {!query.trim() && (
          <button className="iconbtn" title="Add project" onClick={() => useStore.setState({ dialog: "addProject" })}>
            ＋
          </button>
        )}
      </div>
      <div className="tree">
        {query.trim() ? (
          query.trim().length < 2 ? (
            <div className="search-note">Type at least two characters to search.</div>
          ) : searching ? (
            <div className="search-note"><span className="spin" /> Searching session messages…</div>
          ) : searchError ? (
            <div className="search-note search-error">{searchError}</div>
          ) : searchResults.length ? (
            searchResults.map((result) => <SearchHit key={result.session.id} result={result} selected={result.session.id === selected} />)
          ) : (
            <div className="search-note">No sessions mention “{query.trim()}”.</div>
          )
        ) : (
          <>
            {projects.map((p) => (
              <ProjectRow key={p.path} p={p} open={!!expanded[p.path]} />
            ))}
            {archivedProjects.length > 0 && (
              <button className="more" onClick={() => setShowArchived(!showArchived)}>
                {showArchived ? "Hide archived projects" : `Archived projects (${archivedProjects.length})`}
              </button>
            )}
            {showArchived && archivedProjects.map((p) => <ProjectRow key={p.path} p={p} open={!!expanded[p.path]} />)}
            {runnerId && projects.length === 0 && (
              <div className="hint" style={{ padding: "8px 14px" }}>{loaded ? "No projects yet. Add one with ＋." : "Loading projects…"}</div>
            )}
          </>
        )}
      </div>
      <UsagePanel />
      <div className="side-foot">
        <div className="av">{(user?.name || user?.email || "?").slice(0, 1).toUpperCase()}</div>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user?.name || user?.email}</span>
        <span className="grow" />
        <button className="iconbtn" title="Settings: model profiles" onClick={() => useStore.setState({ dialog: "settings" })}>
          ⚙
        </button>
      </div>
    </aside>
  );
}

function SearchHit({ result, selected }: { result: SessionSearchResult; selected: boolean }) {
  const { session } = result;
  return (
    <button
      className={`search-hit${selected ? " selected" : ""}`}
      onClick={() => {
        useStore.setState((state) => ({
          sessions: {
            ...state.sessions,
            [session.projectPath]: [...(state.sessions[session.projectPath] ?? []).filter((item) => item.id !== session.id), session],
          },
        }));
        selectSession(session.id);
      }}
      title={`${session.title} · ${session.projectPath}`}
    >
      <span className="search-hit-title">
        <span className={`h ${session.harness}`}>{badge(session.harness)}</span>
        <span>{session.title}</span>
        <span className="search-hit-time">{ago(session.updatedAt)}</span>
      </span>
      <span className="search-hit-project">{session.projectPath.split(/[\\/]/).filter(Boolean).slice(-1)[0] || session.projectPath}</span>
      <span className="search-hit-excerpt">{result.excerpt}</span>
    </button>
  );
}

/** Collapsed project: just the sessions with a running agent. */
function LiveSessions({ project }: { project: ProjectInfo }) {
  const loaded = useStore((s) => s.sessions[project.path]);
  const selected = useStore((s) => s.selected);
  // Loaded summaries are pushed live by the runner, so they win over the listProjects snapshot.
  const by = new Map(project.live.map((s) => [s.id, s]));
  for (const s of loaded ?? []) if (s.live || by.has(s.id)) by.set(s.id, s);
  const rows = [...by.values()].filter((s) => s.live).sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <>
      {rows.map((s) => (
        <SessionRow key={s.id} s={s} sel={s.id === selected} />
      ))}
    </>
  );
}

/** Expanded project: every session, archived ones last. */
function ProjectRow({ p, open }: { p: ProjectInfo; open: boolean }) {
  const archiveProject = async (archived: boolean) => {
    if (archived && p.live.some((s) => s.status !== "idle") && !confirm(`${p.name} has a running session. Archive the project anyway? The session keeps running.`))
      return;
    if ((await act("archiveProject", { path: p.path, archived })) === undefined) return;
    useStore.setState((st) => ({ projects: st.projects.map((x) => (x.path === p.path ? { ...x, archived } : x)) }));
  };
  return (
    <div className={p.archived ? "proj-archived" : undefined}>
      <div className="projrow">
        <button className={`proj${open ? " open" : ""}`} onClick={() => toggleProject(p.path)} title={p.path}>
          <span className="caret">{open ? "▾" : "▸"}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
          <span className="n">{p.sessionCount || ""}</span>
        </button>
        <button
          className="iconbtn projact"
          title={p.archived ? "Unarchive project" : "Archive project (hide it from this list; nothing is deleted)"}
          onClick={() => archiveProject(!p.archived)}
        >
          <ArchiveIcon />
        </button>
        {!p.archived && (
          <button
            className="iconbtn"
            style={{ marginRight: 8 }}
            title={`New session in ${p.name}`}
            onClick={() => useStore.setState({ dialog: "new", newSessionProject: p.path })}
          >
            ＋
          </button>
        )}
      </div>
      {open ? <ProjectSessions path={p.path} /> : <LiveSessions project={p} />}
    </div>
  );
}

function ProjectSessions({ path }: { path: string }) {
  const sessions = useStore((s) => s.sessions[path]);
  const selected = useStore((s) => s.selected);
  const [all, setAll] = useState(false);
  if (!sessions) return <div className="more">Loading…</div>;
  if (!sessions.length) return <div className="more">No sessions</div>;
  // Live sessions first, archived last, most recent first within each.
  const rank = (s: SessionSummary) => (s.live ? 0 : s.archived ? 2 : 1);
  const sorted = [...sessions].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
  const shown = all ? sorted : sorted.slice(0, SHOW);
  return (
    <>
      {shown.map((s) => (
        <SessionRow key={s.id} s={s} sel={s.id === selected} />
      ))}
      {sorted.length > SHOW && (
        <button className="more" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${sorted.length}`}
        </button>
      )}
    </>
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

export function ArchiveIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="3.5" rx="1" />
      <path d="M2.75 6v6.5a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1V6M6.25 9h3.5" />
    </svg>
  );
}

/** Inline title editor: Enter or leaving the field saves, Escape cancels, empty restores the harness title. */
export function RenameInput({ session, onDone, className = "rename" }: { session: SessionSummary; onDone: () => void; className?: string }) {
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
    <input
      className={className}
      autoFocus
      value={title}
      placeholder="Session name (empty: use the harness title)"
      onFocus={(e) => e.target.select()}
      onChange={(e) => setTitle(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      }}
    />
  );
}

export function PencilIcon() {
  return (
    <svg className="pencil" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M10.5 2.5l3 3L5 14H2v-3z" />
    </svg>
  );
}

function SessionRow({ s, sel }: { s: SessionSummary; sel: boolean }) {
  const [editing, setEditing] = useState(false);
  const notices = useStore((state) => state.notices);
  const noticesRead = useStore((state) => state.noticesRead);
  const noticesSeen = useStore((state) => state.noticesSeen);
  const notice = notices.find((item) => item.sessionId === s.id);
  const noticeRead = notice ? notice.ts <= noticesSeen || noticesRead.includes(notice.id) : false;
  const indicator = notice ? (
    <span
      className={`attention-indicator ${notice.kind === "finished" ? "finished" : "urgent"} ${noticeRead ? "read" : "unread"}`}
      title={`${notice.kind === "finished" ? "Completed" : notice.kind === "question" ? "Question" : "Blocked"} · ${noticeRead ? "Viewed" : "Ready to view"}`}
      aria-label={`${notice.kind === "finished" ? "Completed" : notice.kind === "question" ? "Question" : "Blocked"}, ${noticeRead ? "viewed" : "ready to view"}`}
    />
  ) : s.needsInput ? (
    <span className="need" title="Needs your input" />
  ) : s.status === "running" ? (
    <span className="spin" title="Running" />
  ) : s.status === "waiting" ? (
    <span className="wait" title="Waiting (usage limit or retry)" />
  ) : s.live ? (
    <span className="livedot" title="Live" />
  ) : null;
  if (editing)
    return (
      <div className={`sess${sel ? " sel" : ""}`}>
        <span className="slot">{indicator}</span>
        <RenameInput session={s} onDone={() => setEditing(false)} />
      </div>
    );
  return (
    <button
      className={`sess${sel ? " sel" : ""}${s.archived ? " archived" : ""}`}
      onClick={() => selectSession(s.id)}
      onDoubleClick={() => setEditing(true)}
      title={`${s.title}${notice ? ` · ${notice.kind === "finished" ? "Completed" : notice.kind === "question" ? "Question" : "Blocked"} · ${noticeRead ? "Viewed" : "Ready to view"}` : ""}`}
    >
      <span className="slot">{indicator}</span>
      <span className="t">{s.title}</span>
      <span
        className="rowact"
        role="button"
        title="Rename"
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
      >
        <PencilIcon />
      </span>
      <span className={`h ${s.harness}`}>{badge(s.harness)}</span>
      {!s.live && <span className="ago">{ago(s.updatedAt)}</span>}
      {s.status === "idle" && (
        <span
          className="rowact"
          role="button"
          title={s.archived ? "Unarchive" : "Archive (hidden while the project is collapsed; nothing is deleted)"}
          onClick={(e) => {
            e.stopPropagation();
            archive(s, !s.archived);
          }}
        >
          <ArchiveIcon />
        </span>
      )}
      {s.live && s.status === "idle" && (
        <span
          className="ago"
          role="button"
          title="Stop this session's process"
          onClick={(e) => {
            e.stopPropagation();
            act("closeSession", { sessionId: s.id });
          }}
        >
          ✕
        </span>
      )}
    </button>
  );
}
