// The Files tab's tree (SPEC §10 Files): a WAI-ARIA tree. Each entry is one focusable treeitem
// (roving tabindex): arrows move, Right and Left open and close folders, Enter or Space opens; `@`
// mentions it. The `@` button on a row is for the mouse and touch (not a tab stop). A file that
// differs from HEAD has its name coloured and a letter (M, A, U, R, C); a folder with changes under it
// a dot. Both are said in words too (the row's label and title), never by colour alone.

import { useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { DocumentIcon, FolderIcon, LinkIcon, PhotoIcon } from "@heroicons/react/24/solid";
import { imageType, sizeLabel, type FileEntry } from "../../../shared/files";
import { canOpen, isFolder, markAt, markText, MARKS, treeKey, type Marks, type Row } from "../files";

function EntryIcon({ e, path }: { e: FileEntry; path: string }) {
  if (e.kind === "link") return <Icon icon={LinkIcon} size="sm" />;
  if (e.kind === "dir") return <Icon icon={FolderIcon} size="sm" />;
  return <Icon icon={imageType(path) ? PhotoIcon : DocumentIcon} size="sm" />;
}

const LINK_NOTE: Record<NonNullable<FileEntry["to"]>, string> = { file: "", dir: "", outside: "points outside the folder", broken: "broken link" };

/** A file's change mark: the letter, in its colour (the words are on the row). */
export function MarkBadge({ mark }: { mark: keyof typeof MARKS }) {
  return (
    <span className={`t-dstatus ${mark}`} aria-hidden="true">
      {MARKS[mark].letter}
    </span>
  );
}

export function FileTree({ rows, hidden, marks, mentioned, onToggle, onOpen, onMention }: {
  rows: Row[];
  hidden: boolean;
  /** what differs from HEAD (changeMarks) */
  marks: Marks;
  /** the path just mentioned (its button says so for a moment) */
  mentioned?: string;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  onMention: (path: string, folder: boolean) => void;
}) {
  const [active, setActive] = useState<string>();
  const list = useRef<HTMLUListElement>(null);
  // The tab stop: the entry picked last, else the first.
  const stop = rows.some((r) => r.t === "entry" && r.path === active) ? active : rows.find((r) => r.t === "entry")?.path;

  const onKey = (ev: KeyboardEvent<HTMLLIElement>, i: number) => {
    const r = rows[i];
    if (r?.t !== "entry") return;
    if (ev.key === "@") {
      ev.preventDefault();
      if (isFolder(r.entry) || canOpen(r.entry)) onMention(r.path, isFolder(r.entry));
      return;
    }
    const k = treeKey(rows, i, ev.key);
    if (!k) return;
    ev.preventDefault();
    if (k.t === "toggle") onToggle(k.path);
    else if (k.t === "open") onOpen(k.path);
    else {
      const to = rows[k.index];
      if (to?.t !== "entry") return;
      setActive(to.path);
      (list.current?.querySelector(`[data-row="${k.index}"]`) as HTMLElement | null)?.focus();
    }
  };

  return (
    <ul className="t-files-tree" role="tree" aria-label="Files" ref={list}>
      {rows.map((r, i) => {
        const pad = { paddingLeft: 8 + r.depth * 16 };
        if (r.t !== "entry") {
          const text =
            r.t === "loading" ? (
              <>
                <Spinner size="sm" /> Loading…
              </>
            ) : r.t === "empty" ? (
              r.path || hidden ? "Empty." : "Empty, or only hidden files."
            ) : r.t === "error" ? (
              r.error
            ) : (
              `and ${r.more} more not listed`
            );
          return (
            <li key={`${r.t}:${r.path}`} role="none" className={`t-files-note${r.t === "error" ? " error" : ""}`} style={pad}>
              {text}
            </li>
          );
        }
        const e = r.entry;
        const folder = isFolder(e);
        const openable = canOpen(e);
        const note = e.badName ? "name isn't UTF-8" : e.to ? LINK_NOTE[e.to] : "";
        const mark = markAt(marks, r.path);
        const changed = markText(marks, r.path, folder);
        const said = [note, changed].filter(Boolean).join(", ");
        const act = () => (folder ? onToggle(r.path) : openable ? onOpen(r.path) : undefined);
        return (
          <li
            key={`p:${r.path}`}
            data-row={i}
            data-path={r.path}
            role="treeitem"
            tabIndex={r.path === stop ? 0 : -1}
            aria-level={r.depth + 1}
            aria-expanded={folder ? r.open : undefined}
            aria-disabled={!folder && !openable ? true : undefined}
            aria-label={said ? `${e.name}, ${said}` : undefined}
            className={`t-files-row${e.ignored || e.name.startsWith(".") ? " dim" : ""}${!folder && !openable ? " off" : ""}${mark ? ` changed ${mark}` : ""}`}
            title={said || undefined}
            onFocus={() => setActive(r.path)}
            onKeyDown={(ev) => onKey(ev, i)}
            onClick={act}
          >
            <span className="t-files-item" style={pad}>
              <span className="t-files-chev">{folder && <Icon icon={r.open ? ChevronDownIcon : ChevronRightIcon} size="sm" />}</span>
              <EntryIcon e={e} path={r.path} />
              <span className="t-files-name">{e.name}</span>
              {note && <span className="t-files-note-inline">{note}</span>}
              {e.size !== undefined && <span className="t-files-size">{sizeLabel(e.size)}</span>}
              {mark ? <MarkBadge mark={mark} /> : changed && <span className="t-files-dot" aria-hidden="true" />}
            </span>
            {(folder || openable) && (
              <button
                type="button"
                tabIndex={-1}
                className="t-files-at"
                aria-label={`Mention ${r.path}`}
                title={mentioned === r.path ? "In the message box" : `Mention ${r.path} (@)`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onMention(r.path, folder);
                }}
              >
                {mentioned === r.path ? "✓" : "@"}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
