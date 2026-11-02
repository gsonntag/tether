import { isApiBilling } from "../../../shared/labels";
import { useEffect, useRef, useState } from "react";
import { HARNESS_LABELS, type Billing, type HarnessId, type RunStatus } from "../../../shared/transcript";
import { rpc } from "../connection";
import { openSession } from "../route";
import { folderName, type Row } from "../sessionList";
import { useStore } from "../store";

/** "now", "5m", "3h", "2d", "Oct 3" */
export function shortAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const GLYPHS: Record<HarnessId, string> = { claude: "✻", codex: "◎" };

export function HarnessGlyph({ harness }: { harness: HarnessId }) {
  return (
    <span className="t-glyph" title={HARNESS_LABELS[harness]} aria-label={HARNESS_LABELS[harness]} role="img">
      {GLYPHS[harness] ?? "•"}
    </span>
  );
}

const STATUS_LABEL: Record<RunStatus, string> = { running: "Working", waiting: "Needs you", idle: "Idle" };

export function StatusDot({ status, requests }: { status: RunStatus; requests?: number }) {
  const s = requests ? "waiting" : status;
  if (s === "idle") return null;
  return <span className={`t-dot ${s}`} role="img" aria-label={STATUS_LABEL[s]} title={STATUS_LABEL[s]} />;
}

export function BillingMarker({ billing }: { billing?: Billing }) {
  if (isApiBilling(billing)) return <span className="t-api-marker" role="img" aria-label={billing!.label} title={billing!.label}>$</span>;
  if (!billing || billing.kind === "unknown") return <span className="t-billing-unknown" title="Billing unknown" aria-label="Billing unknown">?</span>;
  return null;
}

export function SessionRow({ row, now, selected, child, runnerLabel }: { row: Row; now: number; selected: boolean; child?: boolean; runnerLabel?: string }) {
  const close = () => useStore.setState({ sidebarOpen: false });
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleBusy, setTitleBusy] = useState(false);
  const [renameError, setRenameError] = useState<string>();
  const titleInput = useRef<HTMLInputElement>(null);
  const editing = useRef(false);
  useEffect(() => {
    if (editingTitle) {
      titleInput.current?.focus();
      titleInput.current?.select();
    }
  }, [editingTitle]);
  const finishTitle = (save: boolean) => {
    if (!editing.current) return;
    editing.current = false;
    const title = titleInput.current?.value.trim();
    setEditingTitle(false);
    if (save && title && title !== row.title) {
      setTitleBusy(true);
      setRenameError(undefined);
      void rpc(row.runnerId, "renameSession", { sessionId: row.id, title })
        .catch((e) => setRenameError((e as Error).message))
        .finally(() => setTitleBusy(false));
    }
  };
  const beginRename = () => {
    if (child || editing.current || titleBusy) return;
    setRenameError(undefined);
    editing.current = true;
    setEditingTitle(true);
  };

  return (
    <div
      className={`t-row${child ? " t-child" : ""}${row.unread ? " unread" : ""}${selected ? " selected" : ""}`}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("input, .t-row-archive")) return;
        beginRename();
      }}
    >
      <button
        type="button"
        className="t-row-open"
        aria-label={`Open session: ${row.title || "Untitled"}`}
        aria-current={selected ? "page" : undefined}
        onKeyDown={(e) => {
          if (e.key === "F2" && !child) {
            e.preventDefault();
            beginRename();
          }
        }}
        onClick={() => {
          openSession(row.runnerId, row.id);
          close();
        }}
      />
      <div className="t-row-content">
        <span className="t-row-title t-row-title-editor">
          <BillingMarker billing={row.billing} />
          {editingTitle ? (
            <input
              ref={titleInput}
              className="t-title-input t-row-title-input"
              aria-label="Session title"
              defaultValue={row.title}
              maxLength={200}
              onBlur={() => finishTitle(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Escape") {
                  e.preventDefault();
                  finishTitle(e.key === "Enter");
                }
              }}
            />
          ) : (
            <span className="t-row-title-text" title={row.title}>
              {row.title || "Untitled"}
            </span>
          )}
        </span>
        <span className="t-row-meta">
          {child ? <span>{row.agentType ?? "subagent"}</span> : <HarnessGlyph harness={row.harness} />}
          {!child && <span className="t-proj">{folderName(row.projectPath)}</span>}
          {runnerLabel && <span className="t-proj">· {runnerLabel}</span>}
          <span>· {shortAgo(row.updatedAt, now)}</span>
          {(!!row.requests || row.status === "waiting") && <span className="t-needs">· Needs you</span>}
          {row.unread && !row.requests && row.status !== "waiting" && !(row.unread === "finished" && row.backgroundSubagents) && <span className={`t-unread ${row.unread}`}>· {row.unread === "failed" ? "Failed" : "Finished"}</span>}
          <StatusDot status={row.status} requests={row.requests} />
        </span>
        {renameError && <span className="t-row-rename-error" role="status">Rename failed: {renameError}</span>}
      </div>
    </div>
  );
}
