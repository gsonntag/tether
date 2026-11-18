// The Files tab of the Changes pane (SPEC §10 Files): the session's folder as a tree (FileTree.tsx),
// loaded a folder at a time from the runner's files module, a name filter, and a viewer (text with
// line numbers, Markdown preview or raw, images, "binary", "too big"). Hidden files (dot files and
// what git ignores) show with the eye toggle, kept per device. Mention puts `@path` in the message
// box. Opened folders and the open file load again on Refresh and when a turn ends (while the tab
// is hidden, when it's shown again). The tree stays mounted under the viewer, so Back keeps its place.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { ArrowLeftIcon, AtSymbolIcon, EyeIcon, EyeSlashIcon } from "@heroicons/react/24/outline";
import { DocumentIcon, PhotoIcon } from "@heroicons/react/24/solid";
import { FILE_VIEW_MAX, imageType, mentionOf, sizeLabel, type DirList, type FileRead, type FindResult } from "../../../shared/files";
import type { RunStatus } from "../../../shared/transcript";
import { rpc } from "../connection";
import { lineNumbers, linkTarget, loadedOpen, mapLimit, nameOf, oddChars, parentOf, pruneOpen, treeRows, viewOf, type DirState } from "../files";
import { viewKey } from "../store";
import { putMention } from "./Composer";
import { FileTree } from "./FileTree";
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
/** Folders asked for at once on a reload. */
const LOADS_AT_ONCE = 4;

export function FilesView({ runnerId, sessionId, status, cover, shown, reload, onLoading }: {
  runnerId: string;
  sessionId: string;
  status: RunStatus;
  /** over the chat (a phone): Mention leaves the box unfocused, so no keyboard comes up */
  cover: boolean;
  /** the tab is showing: a turn that ended while it wasn't loads when it is */
  shown: boolean;
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
  /** a Markdown link that can't be followed, said above the preview */
  const [linkNote, setLinkNote] = useState<string>();
  const viewBody = useRef<HTMLDivElement>(null);
  const gen = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;
  const treeBox = useRef<HTMLDivElement>(null);

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
  /** the top and every open folder, again, a few at a time; folders gone are closed */
  const loadAll = useCallback(async () => {
    const g = ++gen.current;
    onLoading(true);
    const paths = loadedOpen(openRef.current);
    const got = await mapLimit(paths, LOADS_AT_ONCE, (p) => (g === gen.current ? loadDir(p, g) : Promise.resolve({})));
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
  const now = useRef({ file, read });
  now.current = { file, read };
  const again = useCallback(() => {
    void loadAll();
    const { file, read } = now.current;
    if (file) void readIt(file, read?.kind === "text" && !!read.cut);
  }, [loadAll, readIt]);

  // First load, the hidden toggle.
  useEffect(() => void loadAll(), [loadAll]);
  // Refresh.
  useEffect(() => {
    if (reload) again();
  }, [reload]);
  // A turn ended: what it changed shows, now or when the tab is shown.
  const busy = status !== "idle";
  const wasBusy = useRef(busy);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (wasBusy.current && !busy) setStale(true);
    wasBusy.current = busy;
  }, [busy]);
  useEffect(() => {
    if (!stale || !shown) return;
    setStale(false);
    again();
  }, [stale, shown]);

  // The filter: asked a moment after typing stops; after Refresh the folder's list is made again.
  const askedReload = useRef(reload);
  useEffect(() => {
    const q = query.trim();
    setFindError(undefined);
    if (!q) return setFound(undefined);
    const fresh = askedReload.current !== reload;
    const t = setTimeout(async () => {
      askedReload.current = reload;
      try {
        const r = await rpc(runnerId, "findFiles", { sessionId, query: q, hidden, ...(fresh ? { fresh } : {}) });
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
    setLinkNote(undefined);
    setRaw(false);
    void readIt(path);
  };
  /** back to the tree with `path` (a folder) and its parents open, its row focused */
  const revealFolder = (path: string, list?: DirList) => {
    const up = path.split("/").map((_, i, a) => a.slice(0, i + 1).join("/"));
    const next = new Set(open);
    for (const p of up) next.add(p);
    setOpen(next);
    if (list) setDirs((d) => ({ ...d, [path]: { list } }));
    for (const p of ["", ...up.slice(0, -1)]) if (!dirs[p]?.list) void loadDir(p);
    setQuery("");
    setFile(undefined);
    setLinkNote(undefined);
    requestAnimationFrame(() => {
      const row = [...(treeBox.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])].find((e) => e.dataset.path === path);
      row?.scrollIntoView({ block: "nearest" });
      row?.focus();
    });
  };
  const back = () => {
    setFile(undefined);
    // Back where you were: the tree's tab stop (the entry opened), else the filter.
    requestAnimationFrame(() => (treeBox.current?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ?? treeBox.current?.querySelector<HTMLElement>("input"))?.focus());
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
  /**
   * A link in a Markdown preview: a file in the folder opens here, a folder opens in the tree, a
   * heading scrolls the preview (only it); one out of the folder is said above it. Only links away
   * (a scheme) leave; nothing navigates the app.
   */
  const onLink = (href: string, ev: React.MouseEvent<HTMLAnchorElement>) => {
    if (!file) return;
    const to = linkTarget(file, href);
    if (to.t === "away") return;
    ev.preventDefault();
    setLinkNote(undefined);
    if (to.t === "outside") setLinkNote(`“${href}” points outside the session's folder.`);
    else if (to.t === "anchor") {
      const box = viewBody.current;
      const el = box?.querySelector<HTMLElement>(`[id="${CSS.escape(to.id)}"]`);
      if (!box || !el) setLinkNote(`No heading “${to.id}” here.`);
      else box.scrollTo({ top: el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop });
    } else
      // A folder lists; anything else opens as a file.
      void rpc(runnerId, "listDir", { sessionId, path: to.path, hidden }).then(
        (list) => revealFolder(to.path, list),
        () => openFile(to.path),
      );
    return false;
  };

  const rows = useMemo(() => treeRows(dirs, open), [dirs, open]);
  const repo = dirs[""]?.list?.repo;
  const v = file && read && read.path === file ? viewOf(read) : undefined;
  const odd = v && (v.t === "text" || v.t === "markdown") ? oddChars(v.text) : [];

  return (
    <>
      {file && (
        <div className="t-filesview">
          <div className="t-files-viewbar">
            <IconButton label="Back to files" tooltip="Back" size="sm" variant="ghost" icon={<Icon icon={ArrowLeftIcon} />} onClick={back} />
            <span className="t-files-path" title={file}>
              {parentOf(file) && <span className="t-dpath-dir">{parentOf(file)}/</span>}
              <span className="t-dpath-name">{nameOf(file)}</span>
            </span>
            {read && read.path === file && <span className="t-files-size">{sizeLabel(read.size)}</span>}
            {reading && read && <Spinner size="sm" label="Loading" />}
            {v?.t === "markdown" && (
              <div className="t-changes-scopes" role="group" aria-label="Show">
                <button type="button" className="t-changes-scope" aria-pressed={!raw} onClick={() => setRaw(false)}>
                  Preview
                </button>
                <button type="button" className="t-changes-scope" aria-pressed={raw} onClick={() => setRaw(true)}>
                  Raw
                </button>
              </div>
            )}
            <Button label={mentioned === file ? "In the message box" : "Mention"} size="sm" variant="secondary" icon={<Icon icon={AtSymbolIcon} />} onClick={() => mention(file, false)} />
          </div>
          <div className="t-files-body" ref={viewBody}>
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
                {v.cut && read && <div className="t-changes-note">The first {v.lossy ? "part" : sizeLabel(FILE_VIEW_MAX)} of {sizeLabel(read.size)}.</div>}
                {v.lossy && <div className="t-changes-note">Not all UTF-8 text: shown as well as it decodes (� where it doesn't).</div>}
                {odd.length > 0 && <div className="t-changes-note t-files-odd">This file has {odd.join(" and ")}.</div>}
                {linkNote && <div className="t-changes-note error" role="status">{linkNote}</div>}
                {v.t === "markdown" && !raw ? (
                  <div className="t-files-md">
                    <Markdown contentWidth="100%" onLinkClick={onLink}>
                      {v.text}
                    </Markdown>
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
      )}
      <div className="t-filesview" hidden={!!file} ref={treeBox}>
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
                {(found.more || found.partial) && <li className="t-changes-note">{found.more ? "More files match: type more of the name." : "Only part of the folder was looked through."}</li>}
              </ul>
            )
          ) : (
            <FileTree rows={rows} hidden={hidden} mentioned={mentioned} onToggle={toggle} onOpen={openFile} onMention={mention} />
          )}
        </div>
      </div>
    </>
  );
}
