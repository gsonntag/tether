// The Changes pane (SPEC §10 Changes): the session folder's git changes beside the transcript (over
// it on a phone), from the runner's git module. Scopes: Uncommitted and Branch. It loads on opening,
// on a scope change, when a turn ends (later, if a comment is being written), and on Refresh. Lines
// take comments (DiffFile.tsx), which collect in the tray at the bottom and stay in this browser per
// session; Send to agent puts them in the composer as one message, to edit and send, and they stay
// until a message carrying them is sent (reviewStore.ts).
//
// The pane is the place later git views join: a Turn scope (checkpoints) is one more scope, git
// actions (commit, push, a PR) go in the header's actions, and Files a tab beside Changes.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { ArrowPathIcon, XMarkIcon } from "@heroicons/react/24/solid";
import { DIFF_SCOPES, isDiffScope, numberLines, type DiffScope, type GitDiff } from "../../../shared/gitDiff";
import type { RunStatus } from "../../../shared/transcript";
import { rpc } from "../connection";
import { findLines, reviewKey, reviewMessage, type LineComment } from "../review";
import { updateComments, useComments, useUnsaved } from "../reviewStore";
import { useStore, viewKey } from "../store";
import { putDraft } from "./Composer";
import { CommentCard, Counts, DiffFileView, type Sel } from "./DiffFile";
import { useFitViewport } from "./useFitViewport";
import "./ChangesPane.css";

// ---------- the scope, per device ----------

const SCOPE_KEY = "tether.changes.scope";
function storedScope(): DiffScope {
  try {
    const v = localStorage.getItem(SCOPE_KEY);
    return isDiffScope(v) ? v : "uncommitted";
  } catch {
    return "uncommitted";
  }
}

/** Past this many lines, files start folded (a phone stays quick). */
const OPEN_LINES_MAX = 2000;
const NONE: LineComment[] = [];

const touchScreen = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

const EMPTY: Record<DiffScope, string> = { uncommitted: "No uncommitted changes.", branch: "No changes on this branch." };

export function ChangesPane({
  runnerId,
  sessionId,
  status,
  cover,
  onClose,
  onSent,
}: {
  runnerId: string;
  sessionId: string;
  /** the session's run status: the pane loads again when a turn ends */
  status: RunStatus;
  /** over the chat (a phone) rather than beside it */
  cover: boolean;
  onClose: () => void;
  /** Send to agent put the comments in the composer */
  onSent: () => void;
}) {
  const [scope, setScope] = useState<DiffScope>(storedScope);
  const [diff, setDiff] = useState<GitDiff>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<Sel | null>(null);
  /** files folded or unfolded by hand: kept across refreshes */
  const [folds, setFolds] = useState<Map<string, boolean>>(new Map());
  /** whether files start open, decided by the scope's first load */
  const [openFirst, setOpenFirst] = useState<boolean>();
  const [trayOpen, setTrayOpen] = useState(false);
  const linkOpen = useStore((s) => s.link === "open");
  const root = useRef<HTMLElement>(null);
  useFitViewport(root);
  const touch = useMemo(touchScreen, []);
  const key = reviewKey(runnerId, sessionId);
  const comments = useComments(key);
  const unsaved = useUnsaved(key);

  const seq = useRef(0);
  const load = useCallback(
    async (s: DiffScope) => {
      const n = ++seq.current;
      setLoading(true);
      try {
        const d = await rpc(runnerId, "gitDiff", { sessionId, scope: s });
        if (n !== seq.current) return;
        setDiff(d);
        setError(undefined);
      } catch (e) {
        if (n === seq.current) setError((e as Error).message);
      } finally {
        if (n === seq.current) setLoading(false);
      }
    },
    [runnerId, sessionId],
  );
  useEffect(() => {
    if (linkOpen) void load(scope);
  }, [load, scope, linkOpen]);
  // A turn ended: what it changed shows. While a comment is being written that waits for it.
  const busy = status !== "idle";
  const wasBusy = useRef(busy);
  const [owed, setOwed] = useState(false);
  useEffect(() => {
    if (wasBusy.current && !busy) setOwed(true);
    wasBusy.current = busy;
  }, [busy]);
  useEffect(() => {
    if (!owed || sel) return;
    setOwed(false);
    void load(scope);
  }, [owed, sel]);

  const pickScope = (s: DiffScope) => {
    if (s === scope) return;
    setScope(s);
    setDiff(undefined);
    setError(undefined);
    setSel(null);
    setFolds(new Map());
    setOpenFirst(undefined);
    try {
      localStorage.setItem(SCOPE_KEY, s);
    } catch {}
  };

  const shown = diff?.scope === scope ? diff : undefined;
  const files = shown?.files ?? [];
  useEffect(() => {
    if (!shown || openFirst !== undefined) return;
    const lines = shown.files.reduce((n, f) => n + (f.hunks?.reduce((m, h) => m + h.lines.length, 0) ?? 0), 0);
    setOpenFirst(lines <= OPEN_LINES_MAX);
  }, [shown, openFirst]);
  // A reload (Refresh) moved or removed the picked lines: the pick follows them, or goes.
  useEffect(() => {
    if (!sel || !shown) return;
    const f = shown.files.find((x) => x.path === sel.path && x.hunks);
    if (!f || !findLines(f.hunks!.map(numberLines), sel.ka, sel.kb)) setSel(null);
  }, [shown]);

  const isOpen = (path: string) => folds.get(path) ?? openFirst ?? true;
  const toggle = useCallback((path: string) => setFolds((f) => new Map(f).set(path, !(f.get(path) ?? openFirst ?? true))), [openFirst]);
  const inDiff = useMemo(() => new Set(files.map((f) => f.path)), [files]);
  /** this scope's comments, by file (a stable empty list for the rest, so their files don't redraw) */
  const byFile = useMemo(() => {
    const m = new Map<string, LineComment[]>();
    for (const c of comments) if (c.scope === scope) m.set(c.path, [...(m.get(c.path) ?? []), c]);
    return m;
  }, [comments, scope]);

  const now = useRef({ scope, base: shown?.base });
  now.current = { scope, base: shown?.base };
  const add = useCallback(
    (path: string, at: Pick<LineComment, "side" | "start" | "end" | "lines">, text: string) => {
      const { scope, base } = now.current;
      updateComments(key, (l) => [...l, { id: crypto.randomUUID(), path, ...at, text, scope, ...(base ? { base } : {}) }]);
      setSel(null);
    },
    [key],
  );
  const edit = useCallback((id: string, text: string) => updateComments(key, (l) => l.map((c) => (c.id === id ? { ...c, text } : c))), [key]);
  const remove = useCallback((id: string) => updateComments(key, (l) => l.filter((c) => c.id !== id)), [key]);
  const pending = comments.filter((c) => !c.handed);
  const handed = comments.length - pending.length;
  const send = () => {
    const msg = reviewMessage(pending);
    if (!msg) return;
    putDraft(viewKey(runnerId, sessionId), msg);
    // Kept, marked, until a message carrying them is sent (reviewSent).
    updateComments(key, (l) => l.map((c) => (c.handed ? c : { ...c, handed: true })));
    setTrayOpen(false);
    onSent();
  };
  const takeBack = () => updateComments(key, (l) => l.map(({ handed: _, ...c }) => c));
  const show = (c: LineComment) => {
    if (!isOpen(c.path)) toggle(c.path);
    requestAnimationFrame(() => document.getElementById(`t-rc-${c.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  };

  const note = !linkOpen && !shown ? (
    <div className="t-changes-note">Reconnecting…</div>
  ) : error && !shown ? (
    <div className="t-changes-note error">{error}</div>
  ) : !shown ? (
    <div className="t-changes-note">
      <Spinner size="sm" /> Loading…
    </div>
  ) : shown.state === "notRepo" ? (
    <div className="t-changes-note">This folder isn't in a git repository.</div>
  ) : shown.state === "noBase" ? (
    <div className="t-changes-note">{shown.base ? `This branch has no history in common with ${shown.base}.` : "No main or master branch to compare with."}</div>
  ) : !files.length ? (
    <div className="t-changes-note">{EMPTY[scope]}</div>
  ) : null;

  return (
    <aside className="t-changes" aria-label="Changes" ref={root}>
      <div className="t-changes-head">
        <span className="t-changes-title">Changes</span>
        <div className="t-changes-scopes" role="tablist" aria-label="Scope">
          {DIFF_SCOPES.map((s) => (
            <button key={s.id} type="button" role="tab" className="t-changes-scope" aria-selected={s.id === scope} onClick={() => pickScope(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="t-changes-actions">
          {loading && shown ? <Spinner size="sm" label="Refreshing" /> : <IconButton label="Refresh" tooltip="Refresh" size="sm" variant="ghost" icon={<Icon icon={ArrowPathIcon} />} onClick={() => void load(scope)} />}
          <IconButton label="Close changes" tooltip="Close" size="sm" variant="ghost" icon={<Icon icon={XMarkIcon} />} onClick={onClose} />
        </div>
      </div>
      {shown?.state === "ok" && (
        <div className="t-changes-sub">
          <span>
            {files.length} file{files.length === 1 ? "" : "s"}
            {shown.more ? ` (and ${shown.more} more not listed)` : ""}
          </span>
          <Counts added={shown.added} removed={shown.removed} />
          <span className="t-changes-base" title={shown.root}>
            {shown.branch ?? "detached HEAD"}
            {scope === "branch" && shown.base ? ` vs ${shown.base}` : ""}
          </span>
        </div>
      )}
      {shown?.timedOut && <div className="t-changes-note">git took too long: some files show their counts only.</div>}
      {error && shown && <div className="t-changes-note error">{error}</div>}
      <div className="t-changes-body">
        {note}
        {files.map((f) => (
          <DiffFileView
            key={`${f.status}:${f.path}`}
            file={f}
            open={isOpen(f.path)}
            onToggle={toggle}
            sel={sel?.path === f.path ? sel : undefined}
            onSelect={setSel}
            touch={touch}
            comments={byFile.get(f.path) ?? NONE}
            onComment={add}
            onEdit={edit}
            onRemove={remove}
          />
        ))}
      </div>
      {comments.length > 0 && (
        <div className={`t-review-tray${cover ? " cover" : ""}`}>
          {unsaved && <div className="t-changes-note error">Couldn't keep the comments in this browser: they're lost if the page reloads.</div>}
          {trayOpen && (
            <div className="t-review-list">
              {comments.map((c) => (
                <CommentCard key={c.id} c={c} showPlace onPlace={c.scope === scope && inDiff.has(c.path) ? () => show(c) : undefined} onEdit={(t) => edit(c.id, t)} onRemove={() => remove(c.id)} />
              ))}
            </div>
          )}
          <div className="t-review-bar">
            <button type="button" className="t-review-count" aria-expanded={trayOpen} onClick={() => setTrayOpen((o) => !o)}>
              {pending.length ? `${pending.length} comment${pending.length === 1 ? "" : "s"}` : ""}
              {pending.length > 0 && handed > 0 ? " · " : ""}
              {handed ? `${handed} in the message box` : ""}
            </button>
            {handed > 0 && <Button label="Take back" size="sm" variant="ghost" onClick={takeBack} />}
            {pending.length > 0 && <Button label="Send to agent" size="sm" variant="primary" onClick={send} />}
          </div>
        </div>
      )}
    </aside>
  );
}
