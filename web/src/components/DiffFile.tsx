// One file in the Changes pane (SPEC §10 Changes): its header (status, path, counts) and its hunks,
// line by line with old and new numbers. A line takes a comment: click or tap it; Shift-click, or
// drag down the numbers, for a range; on a touch screen a second tap extends the range while the
// comment is still empty. Comments show under the last line they're about.

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/solid";
import { numberLines, type DiffFile, type FileStatus, type NumberedLine } from "../../../shared/gitDiff";
import { location, selectionOf, type LineComment } from "../review";

/** The lines picked for a new comment: indices into one hunk's lines. */
export interface Sel {
  path: string;
  hunk: number;
  a: number;
  b: number;
}

const STATUS: Record<FileStatus, { letter: string; label: string }> = {
  added: { letter: "A", label: "Added" },
  modified: { letter: "M", label: "Modified" },
  deleted: { letter: "D", label: "Deleted" },
  renamed: { letter: "R", label: "Renamed" },
  copied: { letter: "C", label: "Copied" },
  typechange: { letter: "T", label: "Type changed" },
  untracked: { letter: "U", label: "Untracked" },
};

export function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="t-dcounts">
      <span className="add">+{added}</span> <span className="del">−{removed}</span>
    </span>
  );
}

function PathLabel({ path }: { path: string }) {
  const cut = path.lastIndexOf("/") + 1;
  return (
    <span className="t-dpath">
      {cut > 0 && <span className="t-dpath-dir">{path.slice(0, cut)}</span>}
      <span className="t-dpath-name">{path.slice(cut)}</span>
    </span>
  );
}

/** Where a comment sits in a hunk's lines: the line its range ends on. */
const anchorOf = (c: LineComment, l: NumberedLine) => (c.side === "new" ? l.new === c.end : l.op === "-" && l.old === c.end);
const covers = (c: LineComment, l: NumberedLine) => (c.side === "new" ? l.new !== undefined && l.new >= c.start && l.new <= c.end : l.op === "-" && l.old! >= c.start && l.old! <= c.end);

/** A saved comment: its text, Edit and Remove. In the diff and in the tray. */
export function CommentCard({ c, onEdit, onRemove, showPlace, onPlace }: { c: LineComment; onEdit: (text: string) => void; onRemove: () => void; showPlace?: boolean; onPlace?: () => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="t-rcomment" id={showPlace ? undefined : `t-rc-${c.id}`}>
      {showPlace && (
        <button type="button" className="t-rcomment-place" onClick={onPlace} disabled={!onPlace} title={onPlace ? "Show in the diff" : "Not in this diff now"}>
          {location(c)}
        </button>
      )}
      {editing ? (
        <CommentForm
          initial={c.text}
          save="Save"
          onSave={(t) => {
            onEdit(t);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <div className="t-rcomment-text">{c.text}</div>
          <div className="t-rcomment-actions">
            <Button label="Edit" size="sm" variant="ghost" onClick={() => setEditing(true)} />
            <Button label="Remove" size="sm" variant="ghost" onClick={onRemove} />
          </div>
        </>
      )}
    </div>
  );
}

/** The box a comment is written in. ⌘/Ctrl+Enter saves, Esc cancels. */
export function CommentForm({ initial = "", save = "Comment", hint, onSave, onCancel, onText }: { initial?: string; save?: string; hint?: string; onSave: (text: string) => void; onCancel: () => void; onText?: (t: string) => void }) {
  const [text, setText] = useState(initial);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    box.current?.focus({ preventScroll: true });
    box.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const ok = !!text.trim();
  return (
    <div className="t-rform">
      <textarea
        ref={box}
        className="t-rform-box"
        aria-label="Comment"
        placeholder="Comment for the agent…"
        rows={2}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onText?.(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ok) {
            e.preventDefault();
            onSave(text.trim());
          }
        }}
      />
      <div className="t-rform-row">
        {hint && <span className="t-rform-hint">{hint}</span>}
        <Button label="Cancel" size="sm" variant="ghost" onClick={onCancel} />
        <Button label={save} size="sm" variant="primary" isDisabled={!ok} onClick={() => onSave(text.trim())} />
      </div>
    </div>
  );
}

/** Where the new comment goes, and (for one line) how to make it a range. */
function hintFor(lines: NumberedLine[], lo: number, hi: number, path: string, touch: boolean) {
  const at = selectionOf(lines, lo, hi);
  const where = at ? location({ path: path.slice(path.lastIndexOf("/") + 1), ...at }) : "";
  return hi > lo ? where : `${where} · ${touch ? "tap another line for a range" : "Shift-click or drag the numbers for a range"}`;
}

export function DiffFileView({
  file,
  open,
  onToggle,
  sel,
  onSelect,
  touch,
  comments,
  onComment,
  onEdit,
  onRemove,
}: {
  file: DiffFile;
  open: boolean;
  onToggle: () => void;
  /** the selection, when it's in this file */
  sel?: Sel;
  onSelect: (s: Sel | null) => void;
  /** a touch screen: a second tap extends the range */
  touch: boolean;
  /** this file's comments */
  comments: LineComment[];
  onComment: (s: Sel, lines: NumberedLine[], text: string) => void;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
}) {
  const hunks = useMemo(() => (file.hunks ?? []).map(numberLines), [file.hunks]);
  /** what's typed in the new comment's box (a second tap extends only while it's empty) */
  const typed = useRef("");
  // While the numbers are dragged the comment box waits, so the lines under the pointer don't move.
  const dragging = useRef(false);
  const [drag, setDrag] = useState(false);
  useEffect(() => {
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      setDrag(false);
    };
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
    return () => {
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
    };
  }, []);
  useEffect(() => {
    if (!sel) typed.current = "";
  }, [!sel]);

  const pick = (hunk: number, i: number, extend: boolean) => {
    if (extend && sel && sel.hunk === hunk) onSelect({ ...sel, b: i });
    else {
      typed.current = "";
      onSelect({ path: file.path, hunk, a: i, b: i });
    }
  };
  const st = STATUS[file.status];
  const body = file.binary ? (
    <div className="t-dnote">Binary file</div>
  ) : file.tooLarge ? (
    <div className="t-dnote">{file.tooLarge === "file" ? "Too large to show here." : "Not shown: the whole diff is too large."}</div>
  ) : !hunks.length ? (
    <div className="t-dnote">{file.status === "renamed" ? "Renamed, no line changes." : file.added + file.removed === 0 ? "No line changes." : "Not shown."}</div>
  ) : (
    hunks.map((lines, h) => {
      const lo = sel?.hunk === h ? Math.min(sel.a, sel.b) : -1;
      const hi = sel?.hunk === h ? Math.max(sel.a, sel.b) : -1;
      return (
        <div key={h} className="t-dhunk">
          <div className="t-dhunk-head">{file.hunks![h]!.header}</div>
          {lines.map((l, i) => {
            const here = comments.filter((c) => anchorOf(c, l));
            const marked = l.op !== "\\" && comments.some((c) => covers(c, l));
            return (
              <div key={i} className="t-dline-wrap">
                <div
                  className={`t-dline ${l.op === "+" ? "add" : l.op === "-" ? "del" : l.op === "\\" ? "meta" : "ctx"}${i >= lo && i <= hi ? " sel" : ""}${marked ? " noted" : ""}`}
                  // Shift-click picks a range, not text.
                  onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                  onClick={(e) => {
                    // A click that ends selecting text is for copying.
                    if (l.op === "\\" || (!e.shiftKey && getSelection()?.toString())) return;
                    pick(h, i, e.shiftKey || (touch && !typed.current.trim()));
                  }}
                  onPointerEnter={() => dragging.current && sel?.hunk === h && sel.b !== i && onSelect({ ...sel, b: i })}
                >
                  <span
                    className="t-dl-num"
                    onPointerDown={(e) => {
                      if (e.pointerType !== "mouse" || e.button !== 0 || l.op === "\\") return;
                      e.preventDefault();
                      dragging.current = true;
                      setDrag(true);
                      pick(h, i, e.shiftKey);
                    }}
                  >
                    <span className="old">{l.old ?? ""}</span>
                    <span className="new">{l.new ?? ""}</span>
                  </span>
                  <span className="t-dl-op" aria-hidden>
                    {l.op === "\\" ? "" : l.op}
                  </span>
                  <span className="t-dl-text">{l.text}</span>
                </div>
                {here.map((c) => (
                  <CommentCard key={c.id} c={c} onEdit={(t) => onEdit(c.id, t)} onRemove={() => onRemove(c.id)} />
                ))}
                {i === hi && sel && !drag && (
                  <CommentForm
                    key={`${sel.hunk}:${lo}`}
                    hint={hintFor(lines, lo, hi, file.path, touch)}
                    onText={(t) => (typed.current = t)}
                    onSave={(t) => onComment(sel, lines, t)}
                    onCancel={() => onSelect(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      );
    })
  );
  return (
    <section className="t-dfile" aria-label={file.path}>
      <button type="button" className="t-dfile-head" aria-expanded={open} onClick={onToggle}>
        <Icon icon={open ? ChevronDownIcon : ChevronRightIcon} size="sm" />
        <span className={`t-dstatus ${file.status}`} title={st.label} aria-label={st.label}>
          {st.letter}
        </span>
        <span className="t-dfile-name" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.oldPath && (
            <>
              <PathLabel path={file.oldPath} /> <span className="t-dpath-dir">→</span>{" "}
            </>
          )}
          <PathLabel path={file.path} />
        </span>
        {!file.binary && <Counts added={file.added} removed={file.removed} />}
      </button>
      {open && <div className="t-dfile-body">{body}</div>}
    </section>
  );
}
