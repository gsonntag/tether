// The Changes pane's Turn scope (SPEC §10 Checkpoints): which turn to look at, and Restore files to
// before it (or Undo restore, for a restore). Restoring is direct, no confirm: it checkpoints the files
// first, so the restore shows up here as a checkpoint of its own whose Undo puts them back.

import { Button } from "@astryxdesign/core/Button";
import type { CheckpointInfo, CheckpointList, SkipReason } from "../../../shared/checkpoints";

const time = (ms: number) => {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString(undefined, today ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

/** "Turn 3: fix the parser" or "Restored to before turn 3". */
export function checkpointLabel(c: CheckpointInfo, all: CheckpointInfo[]): string {
  if (c.kind === "turn") return `Turn ${c.n}${c.prompt ? `: ${c.prompt}` : ""}`;
  const to = all.find((x) => x.id === c.to);
  return to?.kind === "restore" ? `Undid the restore of ${time(to.at)}` : `Restored to before turn ${c.toN ?? "?"}`;
}

const WHY: Record<SkipReason, string> = {
  nested: "a nested repository",
  folder: "a folder is there",
  symlink: "under a symlink",
  blocked: "a file is where its folder goes",
  unreadable: "couldn't be read",
  ignored: "ignored",
  notTaken: "wasn't in that snapshot",
  outside: "not a path in the repository",
};

const count = (c: CheckpointInfo) => (c.open ? "not finished" : c.files === undefined ? "" : c.files === 0 ? "no changes" : `${c.files} file${c.files === 1 ? "" : "s"}`);

export function TurnBar({
  list,
  picked,
  onPick,
  onRestore,
  restoring,
}: {
  list: CheckpointList;
  picked?: CheckpointInfo;
  onPick: (id: string) => void;
  onRestore: (id: string) => void;
  restoring: boolean;
}) {
  const all = list.checkpoints;
  if (!all.length || !picked) return null;
  const isRestore = picked.kind === "restore";
  const others = list.others;
  const blocked = list.blocked;
  return (
    <div className="t-turnbar">
      <select className="t-select t-turnbar-pick" aria-label="Turn" value={picked.id} onChange={(e) => onPick(e.target.value)}>
        {all.map((c) => {
          const n = count(c);
          return (
            <option key={c.id} value={c.id}>
              {time(c.at)} · {checkpointLabel(c, all)}
              {n ? ` (${n})` : ""}
              {c.late ? " · late" : ""}
            </option>
          );
        })}
      </select>
      {picked.late && <div className="t-turnbar-note">Its before snapshot finished late, so it may already hold the turn's first edits.</div>}
      {picked.skipped && picked.skipped.length > 0 && (
        <details className="t-turnbar-skipped" open={picked.skipped.length <= 5}>
          <summary>
            Left alone: {picked.skipped.length} path{picked.skipped.length === 1 ? "" : "s"}
          </summary>
          <ul>
            {picked.skipped.map((x) => (
              <li key={x.path}>
                <code>{x.path}</code> ({WHY[x.why] ?? x.why})
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="t-turnbar-restore">
        <Button
          label={isRestore ? "Undo restore" : "Restore files to before this turn"}
          size="sm"
          variant="secondary"
          isDisabled={!!blocked || restoring}
          onClick={() => onRestore(picked.id)}
        />
        <span className="t-turnbar-note">
          {blocked ??
            (isRestore
              ? "Puts the files back as they were before this restore."
              : "Files the turn made go, ones it deleted come back. Ignored files, commits and staged changes stay as they are; the files as they are now are kept, so this can be undone.")}
          {others.length > 0 && (
            <>
              {" "}
              Also changes the files of {others.map((o, i) => (
                <span key={o.id}>
                  {i ? ", " : ""}
                  <b>{o.title || "Untitled"}</b>
                  {o.status !== "idle" ? ` (${o.status})` : ""}
                </span>
              ))}
              , in the same repository.
            </>
          )}
        </span>
      </div>
    </div>
  );
}
