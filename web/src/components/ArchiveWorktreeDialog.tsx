import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import type { ArchiveWorktree, WorktreeCleanup } from "../../../shared/protocol";
import { folderName } from "../sessionList";
import { setArchived, useStore } from "../store";

/** What to tell the person after "Delete": nothing once it's gone, else why it stays (or that it's still being checked). */
export function cleanupText(r: WorktreeCleanup | undefined): string | undefined {
  if (r?.slow) return "Archived. Tether is still checking whether its worktree can go; the session's notice will say what it decided.";
  // Neither removed nor kept ({}): there was nothing to remove.
  if (r?.removed !== false) return undefined;
  return `Archived, but its worktree stays: ${r.why ?? "Tether couldn't confirm it's safe to remove"}.`;
}

/**
 * "Delete its worktree too?" on archiving a session in a worktree Tether made (SPEC §4; store's
 * archiveAsk). Delete: archived, and the worktree goes if the usual checks allow (why not, if not).
 * Keep: archived, and Tether never removes it while the session stays archived. Cancel: nothing.
 */
export function ArchiveWorktreeDialog() {
  const ask = useStore((s) => s.archiveAsk);
  const [busy, setBusy] = useState<ArchiveWorktree>();
  const [error, setError] = useState<string>();
  const [said, setSaid] = useState<string>();
  useEffect(() => {
    setBusy(undefined);
    setError(undefined);
    setSaid(undefined);
  }, [ask]);
  if (!ask) return null;
  const close = () => !busy && useStore.setState({ archiveAsk: undefined });
  const answer = async (worktree: ArchiveWorktree) => {
    setBusy(worktree);
    setError(undefined);
    try {
      const text = cleanupText(await setArchived(ask.runnerId, ask.session.id, true, worktree));
      if (text) setSaid(text);
      else useStore.setState({ archiveAsk: undefined });
    } catch (e) {
      setError(`Archive failed: ${(e as Error).message}`);
    } finally {
      setBusy(undefined);
    }
  };
  const branch = ask.session.worktreeBranch;
  return (
    <Dialog isOpen onOpenChange={(o) => !o && close()} width={440} purpose="form">
      <DialogHeader title={said ? "Archived" : "Delete its worktree too?"} onOpenChange={(o) => !o && close()} />
      <div className="t-form" style={{ padding: 16 }}>
        {said ? (
          <>
            <span className="t-inline-status">{said}</span>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button label="OK" variant="primary" onClick={close} />
            </div>
          </>
        ) : (
          <>
            <span className="t-inline-status">
              "{ask.session.title || "Untitled"}" works in a worktree Tether made: <code>{folderName(ask.session.projectPath)}</code>
              {branch ? <> on <code>{branch}</code></> : null}. Delete removes it and its branch, but never uncommitted or unmerged work, nor while another session uses it. Keep leaves it until you remove it yourself.
            </span>
            {error && <div className="t-form-error">{error}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button label="Cancel" variant="secondary" isDisabled={!!busy} onClick={close} />
              <Button label={busy === "keep" ? "Archiving…" : "Keep worktree"} variant="secondary" isDisabled={!!busy} onClick={() => void answer("keep")} />
              <Button label={busy === "remove" ? "Archiving…" : "Delete worktree"} variant="primary" isDisabled={!!busy} onClick={() => void answer("remove")} />
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
