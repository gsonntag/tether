// The Changes pane (SPEC §10 Changes): the session folder's git changes beside the transcript (over
// it on a phone), from the runner's git module. Scopes: Uncommitted, Branch and Turn (a turn's
// checkpoints, with Restore: TurnBar.tsx). It loads on opening, on a scope change, when a turn ends
// (and, in the Turn scope, starts), and on Refresh. Lines take comments (DiffFile.tsx), which
// collect in the tray at the bottom and stay in this browser per session; Send to agent puts them in
// the composer as one message, to edit and send.
//
// The pane is the place later git views join: git actions (commit, push, a PR) go in the header's
// actions, and Files a tab beside Changes.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { ArrowPathIcon, XMarkIcon } from "@heroicons/react/24/solid";
import type { CheckpointList } from "../../../shared/checkpoints";
import { DIFF_SCOPES, isDiffScope, type DiffScope, type GitDiff, type NumberedLine } from "../../../shared/gitDiff";
import type { RunStatus } from "../../../shared/transcript";
import { rpc } from "../connection";
import { readComments, reviewKey, reviewMessage, selectionOf, writeComments, type LineComment } from "../review";
import { useStore, viewKey } from "../store";
import { putDraft } from "./Composer";
import { CommentCard, Counts, DiffFileView, type Sel } from "./DiffFile";
import { TurnBar } from "./TurnBar";
import { useFitViewport } from "./useFitViewport";
import "./ChangesPane.css";

// ---------- comments (this browser, per session) ----------

const useReviews = create<Record<string, LineComment[]>>(() => ({}));

function useComments(key: string): LineComment[] {
  const l = useReviews((s) => s[key]);
  return useMemo(() => l ?? readComments(localStorage, key), [l, key]);
}

function setComments(key: string, list: LineComment[]) {
  useReviews.setState({ [key]: list });
  writeComments(localStorage, key, list);
}

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

const touchScreen = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

const EMPTY: Record<DiffScope, string> = { uncommitted: "No uncommitted changes.", branch: "No changes on this branch.", turn: "No file changes in this turn." };

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
  /** files folded or unfolded against the default */
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const [trayOpen, setTrayOpen] = useState(false);
  const linkOpen = useStore((s) => s.link === "open");
  const root = useRef<HTMLElement>(null);
  useFitViewport(root);
  const touch = useMemo(touchScreen, []);
  const key = reviewKey(runnerId, sessionId);
  const comments = useComments(key);

  // The Turn scope: the session's checkpoints and the one picked (the newest unless you pick another).
  const [cps, setCps] = useState<CheckpointList>();
  const [cp, setCp] = useState<string>();
  const picked = useRef<{ id?: string; newest: boolean }>({ newest: true });
  const [restoring, setRestoring] = useState(false);

  const seq = useRef(0);
  const load = useCallback(
    async (s: DiffScope) => {
      const n = ++seq.current;
      setLoading(true);
      try {
        let checkpoint: string | undefined;
        if (s === "turn") {
          const l = await rpc(runnerId, "checkpoints", { sessionId });
          if (n !== seq.current) return;
          const want = picked.current.newest ? undefined : l.checkpoints.find((c) => c.id === picked.current.id)?.id;
          checkpoint = want ?? l.checkpoints[0]?.id;
          picked.current = { id: checkpoint, newest: !want || checkpoint === l.checkpoints[0]?.id };
          setCps(l);
          setCp(checkpoint);
          if (!checkpoint) {
            setDiff({ scope: s, state: l.state === "notRepo" ? "notRepo" : "noBase", files: [], added: 0, removed: 0 });
            setError(undefined);
            return;
          }
        }
        const d = await rpc(runnerId, "gitDiff", { sessionId, scope: s, ...(checkpoint ? { checkpoint } : {}) });
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
  // A turn ended: what it changed shows. In the Turn scope a new turn shows as it starts.
  const busy = status !== "idle";
  const wasBusy = useRef(busy);
  useEffect(() => {
    if ((wasBusy.current && !busy) || (!wasBusy.current && busy && scope === "turn")) void load(scope);
    wasBusy.current = busy;
  }, [busy]);

  const pickTurn = (id: string) => {
    picked.current = { id, newest: id === cps?.checkpoints[0]?.id };
    setCp(id);
    setSel(null);
    setFlipped(new Set());
    void load("turn");
  };
  const restore = async (id: string) => {
    setRestoring(true);
    try {
      await rpc(runnerId, "restoreCheckpoint", { sessionId, checkpointId: id });
      // The restore is the newest checkpoint now: it shows, with Undo restore.
      picked.current = { newest: true };
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRestoring(false);
    }
    void load("turn");
  };

  const pickScope = (s: DiffScope) => {
    if (s === scope) return;
    setScope(s);
    setDiff(undefined);
    setSel(null);
    setFlipped(new Set());
    try {
      localStorage.setItem(SCOPE_KEY, s);
    } catch {}
  };

  const shown = diff?.scope === scope && (scope !== "turn" || !diff.checkpoint || diff.checkpoint === cp) ? diff : undefined;
  const files = shown?.files ?? [];
  const lineCount = useMemo(() => files.reduce((n, f) => n + (f.hunks?.reduce((m, h) => m + h.lines.length, 0) ?? 0), 0), [files]);
  const openByDefault = lineCount <= OPEN_LINES_MAX;
  const isOpen = (path: string) => openByDefault !== flipped.has(path);
  const toggle = (path: string) =>
    setFlipped((f) => {
      const n = new Set(f);
      if (!n.delete(path)) n.add(path);
      return n;
    });
  const inDiff = useMemo(() => new Set(files.map((f) => f.path)), [files]);

  const add = (s: Sel, lines: NumberedLine[], text: string) => {
    const at = selectionOf(lines, s.a, s.b);
    if (!at) return;
    setComments(key, [...comments, { id: crypto.randomUUID(), path: s.path, ...at, text, scope }]);
    setSel(null);
  };
  const edit = (id: string, text: string) => setComments(key, comments.map((c) => (c.id === id ? { ...c, text } : c)));
  const remove = (id: string) => setComments(key, comments.filter((c) => c.id !== id));
  const send = () => {
    const msg = reviewMessage(comments);
    if (!msg) return;
    putDraft(viewKey(runnerId, sessionId), msg);
    setComments(key, []);
    setTrayOpen(false);
    onSent();
  };
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
    <div className="t-changes-note">{scope === "turn" ? "No turns checkpointed yet. Every turn from now on is, before and after." : "No main or master branch to compare with."}</div>
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
      {scope === "turn" && cps && <TurnBar list={cps} picked={cps.checkpoints.find((c) => c.id === cp)} onPick={pickTurn} onRestore={(id) => void restore(id)} restoring={restoring} />}
      {shown?.state === "ok" && (
        <div className="t-changes-sub">
          <span>
            {files.length} file{files.length === 1 ? "" : "s"}
            {shown.more ? ` (and ${shown.more} more not listed)` : ""}
          </span>
          <Counts added={shown.added} removed={shown.removed} />
          <span className="t-changes-base" title={shown.root}>
            {scope === "turn" ? shown.base : (shown.branch ?? "detached HEAD")}
            {scope === "branch" && shown.base ? ` vs ${shown.base}` : ""}
          </span>
        </div>
      )}
      {error && shown && <div className="t-changes-note error">{error}</div>}
      <div className="t-changes-body">
        {note}
        {files.map((f) => (
          <DiffFileView
            key={f.path}
            file={f}
            open={isOpen(f.path)}
            onToggle={() => toggle(f.path)}
            sel={sel?.path === f.path ? sel : undefined}
            onSelect={setSel}
            touch={touch}
            comments={comments.filter((c) => c.path === f.path)}
            onComment={add}
            onEdit={edit}
            onRemove={remove}
          />
        ))}
      </div>
      {comments.length > 0 && (
        <div className={`t-review-tray${cover ? " cover" : ""}`}>
          {trayOpen && (
            <div className="t-review-list">
              {comments.map((c) => (
                <CommentCard key={c.id} c={c} showPlace onPlace={inDiff.has(c.path) ? () => show(c) : undefined} onEdit={(t) => edit(c.id, t)} onRemove={() => remove(c.id)} />
              ))}
            </div>
          )}
          <div className="t-review-bar">
            <button type="button" className="t-review-count" aria-expanded={trayOpen} onClick={() => setTrayOpen((o) => !o)}>
              {comments.length} comment{comments.length === 1 ? "" : "s"}
            </button>
            <Button label="Send to agent" size="sm" variant="primary" onClick={send} />
          </div>
        </div>
      )}
    </aside>
  );
}
