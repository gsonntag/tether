// Git actions in the Changes pane's header (SPEC §10 Git actions): the branch, its upstream and
// ahead/behind, and Commit, Push and Open PR. Commit and Open PR open a box under the bar, prefilled
// with generated text (a side query on the session's own harness, never a turn) that can be edited;
// text typed before it arrives is kept. Committing on the default branch needs the box's “Commit to
// <main> anyway” ticked. Push is direct. Results and failures (with git's or a hook's output) show
// inline; no dialogs.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Spinner } from "@astryxdesign/core/Spinner";
import type { GitActionResult, GitStatus, PrLookup } from "../../../shared/gitActions";
import type { RunStatus } from "../../../shared/transcript";
import { rpc } from "../connection";
import { actionsFor, branchLine, ghNote } from "../gitActions";
import "./GitBar.css";

type Box = "commit" | "pr";
type Busy = "commit" | "push" | "pr";

export function GitBar({
  runnerId,
  sessionId,
  status,
  tick,
  pr,
  onPr,
  onChanged,
}: {
  runnerId: string;
  sessionId: string;
  status: RunStatus;
  /** the pane loaded again: the branch is read again too */
  tick: number;
  pr?: PrLookup;
  /** an action changed the session's PR, or asks for it again */
  onPr: (fresh: boolean, l?: PrLookup) => void;
  /** a commit changed what Uncommitted shows */
  onChanged: () => void;
}) {
  const [st, setSt] = useState<GitStatus>();
  const [box, setBox] = useState<Box>();
  const [busy, setBusy] = useState<Busy>();
  const [done, setDone] = useState<string>();
  const [failed, setFailed] = useState<{ error: string; output?: string }>();
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [onDefault, setOnDefault] = useState(false);
  const [drafting, setDrafting] = useState<Box>();
  const [draftNote, setDraftNote] = useState<{ box: Box; note: string }>();
  const typed = useRef({ commit: false, pr: false });

  const read = useCallback(async () => {
    try {
      setSt(await rpc(runnerId, "gitStatus", { sessionId }));
    } catch {}
  }, [runnerId, sessionId]);
  useEffect(() => void read(), [read, tick]);

  const draft = async (b: Box) => {
    setDrafting(b);
    setDraftNote(undefined);
    try {
      const d = await rpc(runnerId, "gitDraft", { sessionId, kind: b });
      if (d.note) setDraftNote({ box: b, note: d.note });
      // What was typed meanwhile wins.
      if (b === "commit" && d.message && !typed.current.commit) setMessage(d.message);
      if (b === "pr" && d.title && !typed.current.pr) {
        setTitle(d.title);
        setBody(d.body ?? "");
      }
    } catch (e) {
      setDraftNote({ box: b, note: `Couldn't generate one: ${(e as Error).message}` });
    } finally {
      setDrafting(undefined);
    }
  };
  const openBox = (b: Box) => {
    setFailed(undefined);
    setDone(undefined);
    if (box === b) return setBox(undefined);
    setBox(b);
    if (b === "commit" && !message.trim()) void draft("commit");
    if (b === "pr" && !title.trim()) void draft("pr");
  };

  const after = (r: GitActionResult, ok: string) => {
    setSt(r.status);
    if (r.pr) onPr(false, { gh: "ok", pr: r.pr, at: Date.now() });
    if (r.ok) {
      setFailed(undefined);
      setDone(ok);
    } else {
      setDone(undefined);
      setFailed({ error: r.error ?? "It failed.", ...(r.output ? { output: r.output } : {}) });
    }
  };
  const act = async (what: Busy, f: () => Promise<void>) => {
    setBusy(what);
    setDone(undefined);
    setFailed(undefined);
    try {
      await f();
    } catch (e) {
      setFailed({ error: (e as Error).message });
    } finally {
      setBusy(undefined);
    }
  };
  const commit = () =>
    act("commit", async () => {
      const r = await rpc(runnerId, "gitCommit", { sessionId, message, ...(onDefault ? { onDefault: true } : {}) }, 125_000);
      after(r, `Committed ${r.commit ?? ""} on ${r.status.branch ?? "HEAD"}.`);
      if (r.ok) {
        setMessage("");
        typed.current.commit = false;
        setOnDefault(false);
        setBox(undefined);
      }
      onChanged();
    });
  const push = () =>
    act("push", async () => {
      const r = await rpc(runnerId, "gitPush", { sessionId }, 125_000);
      after(r, `Pushed to ${r.status.upstream ?? "origin"}.`);
      if (r.ok) onPr(true);
    });
  const openPr = () =>
    act("pr", async () => {
      const r = await rpc(runnerId, "gitOpenPr", { sessionId, title, body }, 125_000);
      after(r, r.pr ? `Opened #${r.pr.number}.` : "Opened the PR.");
      if (r.ok) {
        setTitle("");
        setBody("");
        typed.current.pr = false;
        setBox(undefined);
      }
    });

  if (!st || st.state !== "ok") return null;
  const why = actionsFor(st, pr);
  const isDefault = !!st.branch && st.branch === st.defaultBranch;
  const working = status === "running";
  const note = ghNote(pr);
  const needsPush = !st.upstream || st.ahead > 0;

  return (
    <div className="t-gitbar">
      <div className="t-gitbar-row">
        <span className="t-gitbar-branch" title={st.root}>
          {branchLine(st)}
        </span>
        <div className="t-gitbar-buttons">
          <Button label="Commit" size="sm" variant={box === "commit" ? "primary" : "secondary"} isDisabled={!!why.commit || !!busy} tooltip={why.commit} onClick={() => openBox("commit")} />
          <Button label={busy === "push" ? "Pushing…" : "Push"} size="sm" variant="secondary" isDisabled={!!why.push || !!busy} tooltip={why.push} onClick={() => void push()} />
          <Button label="Open PR" size="sm" variant={box === "pr" ? "primary" : "secondary"} isDisabled={!!why.pr || !!busy} tooltip={why.pr} onClick={() => openBox("pr")} />
        </div>
      </div>
      {note && <div className="t-gitbar-note">{note}</div>}
      {box === "commit" && (
        <div className="t-rform t-gitbar-box">
          <textarea
            className="t-rform-box"
            aria-label="Commit message"
            placeholder={drafting === "commit" ? "Writing a message…" : "Commit message"}
            rows={4}
            value={message}
            onChange={(e) => {
              typed.current.commit = true;
              setMessage(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setBox(undefined);
            }}
          />
          {draftNote?.box === "commit" && <div className="t-gitbar-note">{draftNote.note}</div>}
          <div className="t-gitbar-note">
            {st.changed} file{st.changed === 1 ? "" : "s"}, everything in Uncommitted
            {st.identity ? `, as ${st.identity}` : ""}.{!st.identity && <b> git has no name and email on this computer: set user.name and user.email there.</b>}
          </div>
          {isDefault && (
            <label className="t-gitbar-check">
              <input type="checkbox" checked={onDefault} onChange={(e) => setOnDefault(e.target.checked)} /> Commit to {st.branch} anyway
            </label>
          )}
          <div className="t-rform-row">
            {drafting === "commit" && <Spinner size="sm" label="Writing a message" />}
            <Button label="Cancel" size="sm" variant="ghost" onClick={() => setBox(undefined)} />
            <Button
              label={busy === "commit" ? "Committing…" : "Commit"}
              size="sm"
              variant="primary"
              isDisabled={!message.trim() || !!busy || (isDefault && !onDefault) || !st.identity || working}
              tooltip={working ? "The session is working. Commit when its turn ends." : undefined}
              onClick={() => void commit()}
            />
          </div>
        </div>
      )}
      {box === "pr" && (
        <div className="t-rform t-gitbar-box">
          <input
            className="t-rform-box t-gitbar-title"
            aria-label="PR title"
            placeholder={drafting === "pr" ? "Writing a title…" : "Title"}
            value={title}
            onChange={(e) => {
              typed.current.pr = true;
              setTitle(e.target.value);
            }}
          />
          <textarea
            className="t-rform-box"
            aria-label="PR description"
            placeholder={drafting === "pr" ? "Writing a description…" : "Description"}
            rows={6}
            value={body}
            onChange={(e) => {
              typed.current.pr = true;
              setBody(e.target.value);
            }}
          />
          {draftNote?.box === "pr" && <div className="t-gitbar-note">{draftNote.note}</div>}
          <div className="t-gitbar-note">
            {st.branch} into {st.defaultBranch}
            {needsPush ? `; pushes ${st.branch} to origin first` : ""}.
          </div>
          <div className="t-rform-row">
            {drafting === "pr" && <Spinner size="sm" label="Writing a description" />}
            <Button label="Cancel" size="sm" variant="ghost" onClick={() => setBox(undefined)} />
            <Button label={busy === "pr" ? "Opening…" : "Open PR"} size="sm" variant="primary" isDisabled={!title.trim() || !!busy} onClick={() => void openPr()} />
          </div>
        </div>
      )}
      {done && <div className="t-gitbar-note t-gitbar-done">{done}</div>}
      {failed && (
        <div className="t-gitbar-failed" role="alert">
          <div>{failed.error}</div>
          {failed.output && <pre className="t-gitbar-output">{failed.output}</pre>}
        </div>
      )}
    </div>
  );
}
