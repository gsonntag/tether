// The Changes pane (SPEC §10 Changes): the session folder's git changes beside the transcript (over
// it on a phone), from the runner's git module. Scopes: Uncommitted, Branch and Turn (a turn's
// checkpoints, with Restore: TurnBar.tsx). It loads on opening, on a scope change, when a turn ends
// (and, in the Turn scope, starts; later, if a comment is being written), and on Refresh. Lines take
// comments (DiffFile.tsx), which collect in the tray at the bottom and stay in this browser per
// session; Send to agent puts them in the composer as one message, to edit and send, and they stay
// until a message carrying them is sent (reviewStore.ts).
//
// Git actions (GitBar.tsx: the branch, Commit, Push, Open PR) sit under the header. Files, a later
// git view, would be a tab beside Changes.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { ArrowPathIcon, XMarkIcon } from "@heroicons/react/24/solid";
import type { CheckpointList } from "../../../shared/checkpoints";
import type { PrLookup } from "../../../shared/gitActions";
import { DIFF_SCOPES, isDiffScope, numberLines, type DiffScope, type GitDiff } from "../../../shared/gitDiff";
import type { RunStatus } from "../../../shared/transcript";
import { rpc } from "../connection";
import { findLines, reviewKey, reviewMessage, unhand, unhandMissing, type LineComment } from "../review";
import { updateComments, useComments, useUnsaved } from "../reviewStore";
import { useStore, viewKey } from "../store";
import { draftOf, putDraft } from "./Composer";
import { CommentCard, Counts, DiffFileView, fileKey, type Sel } from "./DiffFile";
import { GitBar } from "./GitBar";
import { TurnBar } from "./TurnBar";
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

const EMPTY: Record<DiffScope, string> = { uncommitted: "No uncommitted changes.", branch: "No changes on this branch.", turn: "No file changes in this turn." };

export function ChangesPane({
  runnerId,
  sessionId,
  status,
  cover,
  git,
  onClose,
  onSent,
}: {
  runnerId: string;
  sessionId: string;
  /** the session's run status: the pane loads again when a turn ends */
  status: RunStatus;
  /** over the chat (a phone) rather than beside it */
  cover: boolean;
  /** the runner has git actions: the session's PR, and how to update it (SessionView's usePr) */
  git?: { pr?: PrLookup; update: (fresh: boolean, l?: PrLookup) => void };
  onClose: () => void;
  /** Send to agent put the comments in the composer */
  onSent: () => void;
}) {
  const [scope, setScope] = useState<DiffScope>(storedScope);
  const [diff, setDiff] = useState<GitDiff>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<Sel | null>(null);
  /** files (by fileKey) folded or unfolded by hand: kept across refreshes */
  const [folds, setFolds] = useState<Map<string, boolean>>(new Map());
  /** whether files start open: decided by each load until one is folded or unfolded by hand */
  const [openFirst, setOpenFirst] = useState<boolean>();
  const [trayOpen, setTrayOpen] = useState(false);
  const linkOpen = useStore((s) => s.link === "open");
  const root = useRef<HTMLElement>(null);
  useFitViewport(root);
  const touch = useMemo(touchScreen, []);
  const key = reviewKey(runnerId, sessionId);
  const comments = useComments(key);
  const unsaved = useUnsaved(key);

  // The Turn scope: the session's checkpoints and the one picked (the newest unless you pick another).
  const [cps, setCps] = useState<CheckpointList>();
  const [cp, setCp] = useState<string>();
  const picked = useRef<{ id?: string; newest: boolean }>({ newest: true });
  const [restoring, setRestoring] = useState(false);

  const seq = useRef(0);
  /** loads so far: the git bar reads the branch again with each */
  const [tick, setTick] = useState(0);
  const load = useCallback(
    async (s: DiffScope) => {
      const n = ++seq.current;
      setLoading(true);
      setTick((t) => t + 1);
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
  // Comments said to be in the message box that it doesn't hold (a reload emptied it) are back in the tray.
  useEffect(() => updateComments(key, (l) => unhandMissing(l, draftOf(viewKey(runnerId, sessionId)))), [key]);
  /** a reload waiting for the comment being written (a turn ended, the link came back) */
  const [owed, setOwed] = useState(false);
  const writing = useRef(false);
  writing.current = !!sel;
  const loaded = useRef<DiffScope>(undefined);
  useEffect(() => {
    if (!linkOpen) return;
    if (writing.current && loaded.current === scope) return setOwed(true);
    loaded.current = scope;
    void load(scope);
  }, [load, scope, linkOpen]);
  // A turn ended: what it changed shows; in the Turn scope a new turn shows as it starts. While a
  // comment is being written that waits for it.
  const busy = status !== "idle";
  const wasBusy = useRef(busy);
  useEffect(() => {
    if ((wasBusy.current && !busy) || (!wasBusy.current && busy && scope === "turn")) setOwed(true);
    wasBusy.current = busy;
  }, [busy]);
  useEffect(() => {
    if (!owed || sel) return;
    setOwed(false);
    void load(scope);
  }, [owed, sel]);

  const pickTurn = (id: string) => {
    picked.current = { id, newest: id === cps?.checkpoints[0]?.id };
    setCp(id);
    setSel(null);
    setFolds(new Map());
    setOpenFirst(undefined);
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
    setError(undefined);
    setSel(null);
    setFolds(new Map());
    setOpenFirst(undefined);
    try {
      localStorage.setItem(SCOPE_KEY, s);
    } catch {}
  };

  const shown = diff?.scope === scope && (scope !== "turn" || !diff.checkpoint || diff.checkpoint === cp) ? diff : undefined;
  const files = shown?.files ?? [];
  useEffect(() => {
    if (!shown || folds.size) return;
    const lines = shown.files.reduce((n, f) => n + (f.hunks?.reduce((m, h) => m + h.lines.length, 0) ?? 0), 0);
    setOpenFirst(lines <= OPEN_LINES_MAX);
  }, [shown]);
  // A reload (Refresh) moved or removed the picked lines: the pick follows them, or goes.
  useEffect(() => {
    if (!sel || !shown) return;
    const f = shown.files.find((x) => fileKey(x) === sel.file && x.hunks);
    if (!f || !findLines(f.hunks!.map(numberLines), sel.ka, sel.kb)) setSel(null);
  }, [shown]);

  const isOpen = (k: string) => folds.get(k) ?? openFirst ?? true;
  const toggle = useCallback((k: string) => setFolds((f) => new Map(f).set(k, !(f.get(k) ?? openFirst ?? true))), [openFirst]);
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
  // An edit made after Send to agent isn't in the message box: the comment is back in the tray.
  const edit = useCallback((id: string, text: string) => updateComments(key, (l) => l.map((c) => (c.id === id ? { ...unhand(c), text } : c))), [key]);
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
  const takeBack = () => updateComments(key, (l) => l.map(unhand));
  const show = (c: LineComment) => {
    const f = files.find((x) => x.path === c.path && x.hunks) ?? files.find((x) => x.path === c.path);
    if (f && !isOpen(fileKey(f))) toggle(fileKey(f));
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
    <div className="t-changes-note">
      {scope === "turn" ? "No turns checkpointed yet. Every turn from now on is, before and after." : shown.base ? `This branch has no history in common with ${shown.base}.` : "No main or master branch to compare with."}
    </div>
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
          {loading && shown ? <Spinner size="sm" label="Refreshing" /> : <IconButton label="Refresh" tooltip="Refresh" size="sm" variant="ghost" icon={<Icon icon={ArrowPathIcon} />} onClick={() => (setOwed(false), void load(scope))} />}
          <IconButton label="Close changes" tooltip="Close" size="sm" variant="ghost" icon={<Icon icon={XMarkIcon} />} onClick={onClose} />
        </div>
      </div>
      {git && <GitBar runnerId={runnerId} sessionId={sessionId} status={status} tick={tick} pr={git.pr} onPr={git.update} onChanged={() => (setOwed(false), void load(scope))} />}
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
      {owed && (
        <div className="t-changes-note t-changes-owed">
          New changes.
          <Button
            label="Show them"
            size="sm"
            variant="secondary"
            onClick={() => {
              setOwed(false);
              void load(scope);
            }}
          />
        </div>
      )}
      {shown?.timedOut && <div className="t-changes-note">git took too long: some files show their counts only.</div>}
      {error && shown && <div className="t-changes-note error">{error}</div>}
      <div className="t-changes-body">
        {note}
        {files.map((f) => (
          <DiffFileView
            key={fileKey(f)}
            file={f}
            open={isOpen(fileKey(f))}
            onToggle={toggle}
            sel={sel?.file === fileKey(f) ? sel : undefined}
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
