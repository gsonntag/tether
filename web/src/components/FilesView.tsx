// The Files tab of the Changes pane (SPEC §10 Files): the session's folder as a tree, loaded a folder
// at a time from the runner's files module, a name filter, and a viewer (text with line numbers,
// Markdown preview or raw, images, "binary", "too big"). Hidden files (dot files and what git
// ignores) show with the eye toggle, kept per device. Mention puts `@path` in the message box.
// Opened folders and the open file load again on Refresh and when a turn ends.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { ArrowLeftIcon, AtSymbolIcon, ChevronDownIcon, ChevronRightIcon, EyeIcon, EyeSlashIcon } from "@heroicons/react/24/outline";
import { DocumentIcon, FolderIcon, LinkIcon, PhotoIcon } from "@heroicons/react/24/solid";
import { FILE_VIEW_MAX, imageType, mentionOf, sizeLabel, type FileEntry, type FileRead, type FindResult } from "../../../shared/files";
import type { RunStatus } from "../../../shared/transcript";
import { rpc } from "../connection";
import { canOpen, isFolder, lineNumbers, loadedOpen, nameOf, parentOf, pruneOpen, treeRows, viewOf, type DirState } from "../files";
import { viewKey } from "../store";
import { putMention } from "./Composer";
import { Markdown } from "./Markdown";
import "./FilesView.css";

const HIDDEN_KEY = "tether.files.hidden";
const storedHidden = () => {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
};

function EntryIcon({ e, path }: { e: FileEntry; path: string }) {
  if (e.kind === "link") return <Icon icon={LinkIcon} size="sm" />;
  if (e.kind === "dir") return <Icon icon={FolderIcon} size="sm" />;
  return <Icon icon={imageType(path) ? PhotoIcon : DocumentIcon} size="sm" />;
}

const linkNote: Record<NonNullable<FileEntry["to"]>, string> = {
  file: "",
  dir: "",
  outside: "points outside the folder",
  broken: "broken link",
};

export function FilesView({ runnerId, sessionId, status, cover, reload, onLoading }: {
  runnerId: string;
  sessionId: string;
  status: RunStatus;
  /** over the chat (a phone): Mention leaves the box unfocused, so no keyboard comes up */
  cover: boolean;
  /** Refresh in the pane's header: a new number loads again */
  reload: number;
  onLoading: (loading: boolean) => void;
}) {
  const [hidden, setHidden] = useState(storedHidden);
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<FindResult & { query: string }>();
  const [findError, setFindError] = useState<string>();
  const [file, setFile] = useState<string>();
  const [read, setRead] = useState<FileRead>();
  const [readError, setReadError] = useState<string>();
  const [reading, setReading] = useState(false);
  const [raw, setRaw] = useState(false);
  const [mentioned, setMentioned] = useState<string>();
  const gen = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;

  const loadDir = useCallback(
    async (path: string, g = gen.current): Promise<DirState> => {
      setDirs((d) => ({ ...d, [path]: { ...d[path], loading: true } }));
      let got: DirState;
      try {
        got = { list: await rpc(runnerId, "listDir", { sessionId, path, hidden }) };
      } catch (e) {
        got = { error: (e as Error).message };
      }
      if (g === gen.current) setDirs((d) => ({ ...d, [path]: got }));
      return got;
    },
    [runnerId, sessionId, hidden],
  );
  /** the top and every open folder, again; folders gone are closed */
  const loadAll = useCallback(async () => {
    const g = ++gen.current;
    onLoading(true);
    const paths = loadedOpen(openRef.current);
    const got = await Promise.all(paths.map((p) => loadDir(p, g)));
    if (g !== gen.current) return;
    onLoading(false);
    const now = Object.fromEntries(paths.map((p, i) => [p, got[i]!]));
    setOpen((o) => pruneOpen(o, now));
  }, [loadDir]);

  const readSeq = useRef(0);
  const readIt = useCallback(
    async (path: string, head = false) => {
      const n = ++readSeq.current;
      setReading(true);
      try {
        const r = await rpc(runnerId, "readFile", { sessionId, path, ...(head ? { head } : {}) });
        if (n !== readSeq.current) return;
        setRead(r);
        setReadError(undefined);
      } catch (e) {
        if (n === readSeq.current) setReadError((e as Error).message);
      } finally {
        if (n === readSeq.current) setReading(false);
      }
    },
    [runnerId, sessionId],
  );

  // First load, the hidden toggle, Refresh.
  useEffect(() => void loadAll(), [loadAll, reload]);
  useEffect(() => {
    if (file && reload) void readIt(file, read?.kind === "text" && !!read.cut);
  }, [reload]);
  // A turn ended: what it changed shows.
  const busy = status !== "idle";
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      void loadAll();
      if (file) void readIt(file, read?.kind === "text" && !!read.cut);
    }
    wasBusy.current = busy;
  }, [busy]);

  // The filter: asked a moment after typing stops.
  useEffect(() => {
    const q = query.trim();
    if (!q) return setFound(undefined);
    const t = setTimeout(async () => {
      try {
        const r = await rpc(runnerId, "findFiles", { sessionId, query: q, hidden });
        setFound({ ...r, query: q });
        setFindError(undefined);
      } catch (e) {
        setFindError((e as Error).message);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [query, hidden, runnerId, sessionId, reload]);

  const toggleHidden = () => {
    const v = !hidden;
    setHidden(v);
    try {
      localStorage.setItem(HIDDEN_KEY, v ? "1" : "0");
    } catch {}
  };
  const toggle = (path: string) => {
    const next = new Set(open);
    if (next.has(path)) next.delete(path);
    else {
      next.add(path);
      if (!dirs[path]?.list) void loadDir(path);
    }
    setOpen(next);
  };
  const openFile = (path: string) => {
    setFile(path);
    setRead(undefined);
    setReadError(undefined);
    setRaw(false);
    void readIt(path);
  };
  const mention = (path: string, folder: boolean) => {
    putMention(viewKey(runnerId, sessionId), mentionOf(folder ? `${path}/` : path), !cover);
    setMentioned(path);
  };
  useEffect(() => {
    if (!mentioned) return;
    const t = setTimeout(() => setMentioned(undefined), 2000);
    return () => clearTimeout(t);
  }, [mentioned]);

  const rows = useMemo(() => treeRows(dirs, open), [dirs, open]);
  const repo = dirs[""]?.list?.repo;

  if (file) {
    const v = read && read.path === file ? viewOf(read) : undefined;
    return (
      <div className="t-filesview">
        <div className="t-files-viewbar">
          <IconButton label="Back to files" tooltip="Back" size="sm" variant="ghost" icon={<Icon icon={ArrowLeftIcon} />} onClick={() => setFile(undefined)} />
          <span className="t-files-path" title={file}>
            {parentOf(file) && <span className="t-dpath-dir">{parentOf(file)}/</span>}
            <span className="t-dpath-name">{nameOf(file)}</span>
          </span>
          {read && read.path === file && <span className="t-files-size">{sizeLabel(read.size)}</span>}
          {reading && read && <Spinner size="sm" label="Loading" />}
          {v?.t === "markdown" && (
            <div className="t-changes-scopes" role="tablist" aria-label="Show">
              <button type="button" role="tab" className="t-changes-scope" aria-selected={!raw} onClick={() => setRaw(false)}>
                Preview
              </button>
              <button type="button" role="tab" className="t-changes-scope" aria-selected={raw} onClick={() => setRaw(true)}>
                Raw
              </button>
            </div>
          )}
          <Button label={mentioned === file ? "In the message box" : "Mention"} size="sm" variant="secondary" icon={<Icon icon={AtSymbolIcon} />} onClick={() => mention(file, false)} />
        </div>
        <div className="t-files-body">
          {readError ? (
            <div className="t-changes-note error">{readError}</div>
          ) : !v ? (
            <div className="t-changes-note">
              <Spinner size="sm" /> Loading…
            </div>
          ) : v.t === "image" ? (
            <div className="t-files-image">
              <img src={v.src} alt={nameOf(file)} />
            </div>
          ) : v.t === "binary" ? (
            <div className="t-changes-note">Binary, {sizeLabel(v.size)}.</div>
          ) : v.t === "tooBig" ? (
            <div className="t-changes-note t-files-big">
              {sizeLabel(v.size)}: too big to show here.
              {!imageType(file) && <Button label={`Show the first ${sizeLabel(FILE_VIEW_MAX)}`} size="sm" variant="secondary" onClick={() => void readIt(file, true)} />}
            </div>
          ) : (
            <>
              {v.cut && read && <div className="t-changes-note">The first {sizeLabel(FILE_VIEW_MAX)} of {sizeLabel(read.size)}.</div>}
              {v.t === "markdown" && !raw ? (
                <div className="t-files-md">
                  <Markdown contentWidth="100%">{v.text}</Markdown>
                </div>
              ) : (
                <div className="t-files-code">
                  <pre className="t-files-gutter" aria-hidden="true">
                    {lineNumbers(v.text)}
                  </pre>
                  <pre className="t-files-text">{v.text}</pre>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="t-filesview">
      <div className="t-files-bar">
        <input className="t-search t-files-filter" type="search" placeholder="Filter by name" aria-label="Filter by name" value={query} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
        <IconButton
          label={hidden ? "Hide hidden files" : "Show hidden files"}
          tooltip={hidden ? `Hide dot files${repo ? " and ignored files" : ""}` : `Show dot files${repo ? " and ignored files" : ""}`}
          size="sm"
          variant={hidden ? "secondary" : "ghost"}
          aria-pressed={hidden}
          icon={<Icon icon={hidden ? EyeIcon : EyeSlashIcon} />}
          onClick={toggleHidden}
        />
      </div>
      <div className="t-files-body">
        {query.trim() ? (
          findError ? (
            <div className="t-changes-note error">{findError}</div>
          ) : !found || found.query !== query.trim() ? (
            <div className="t-changes-note">
              <Spinner size="sm" /> Looking…
            </div>
          ) : !found.paths.length ? (
            <div className="t-changes-note">No files match.</div>
          ) : (
            <ul className="t-files-tree" aria-label="Matching files">
              {found.paths.map((p) => (
                <li key={p} className="t-files-row">
                  <button type="button" className="t-files-item" onClick={() => openFile(p)}>
                    <Icon icon={imageType(p) ? PhotoIcon : DocumentIcon} size="sm" />
                    <span className="t-files-name">
                      {parentOf(p) && <span className="t-dpath-dir">{parentOf(p)}/</span>}
                      {nameOf(p)}
                    </span>
                  </button>
                </li>
              ))}
              {(found.more || found.partial) && (
                <li className="t-changes-note">{found.more ? "More files match: type more of the name." : "Only part of the folder was looked through."}</li>
              )}
            </ul>
          )
        ) : (
          <ul className="t-files-tree" role="tree" aria-label="Files">
            {rows.map((r) => {
              const pad = { paddingLeft: 8 + r.depth * 16 };
              if (r.t === "loading")
                return (
                  <li key={`l:${r.path}`} className="t-files-note" style={pad}>
                    <Spinner size="sm" /> Loading…
                  </li>
                );
              if (r.t === "empty")
                return (
                  <li key={`e:${r.path}`} className="t-files-note" style={pad}>
                    {r.path || hidden ? "Empty." : "Empty, or only hidden files."}
                  </li>
                );
              if (r.t === "error")
                return (
                  <li key={`x:${r.path}`} className="t-files-note error" style={pad}>
                    {r.error}
                  </li>
                );
              if (r.t === "more")
                return (
                  <li key={`m:${r.path}`} className="t-files-note" style={pad}>
                    and {r.more} more not listed
                  </li>
                );
              const e = r.entry;
              const folder = isFolder(e);
              const openable = canOpen(e);
              const note = e.badName ? "name isn't UTF-8" : e.to ? linkNote[e.to] : "";
              return (
                <li key={`p:${r.path}`} className={`t-files-row${e.ignored || e.name.startsWith(".") ? " dim" : ""}`} role="treeitem" aria-expanded={folder ? r.open : undefined}>
                  <button
                    type="button"
                    className="t-files-item"
                    style={pad}
                    disabled={!folder && !openable}
                    title={note || undefined}
                    onClick={() => (folder ? toggle(r.path) : openFile(r.path))}
                  >
                    <span className="t-files-chev">{folder && <Icon icon={r.open ? ChevronDownIcon : ChevronRightIcon} size="sm" />}</span>
                    <EntryIcon e={e} path={r.path} />
                    <span className="t-files-name">{e.name}</span>
                    {note && <span className="t-files-note-inline">{note}</span>}
                    {e.size !== undefined && <span className="t-files-size">{sizeLabel(e.size)}</span>}
                  </button>
                  {(folder || openable) && (
                    <button type="button" className="t-files-at" aria-label={`Mention ${r.path}`} title={mentioned === r.path ? "In the message box" : `Mention ${r.path}`} onClick={() => mention(r.path, folder)}>
                      {mentioned === r.path ? "✓" : "@"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
