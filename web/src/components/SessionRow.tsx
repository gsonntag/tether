import type { HarnessId, RunStatus } from "../../../shared/transcript";
import { HARNESS_LABELS } from "../../../shared/transcript";
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

export function SessionRow({ row, now, selected, child, runnerLabel }: { row: Row; now: number; selected: boolean; child?: boolean; runnerLabel?: string }) {
  const close = () => useStore.setState({ sidebarOpen: false });
  return (
    <button
      type="button"
      className={`t-row${child ? " t-child" : ""}`}
      aria-current={selected ? "page" : undefined}
      onClick={() => {
        openSession(row.runnerId, row.id);
        close();
      }}
    >
      <span className="t-row-title">{row.title || "Untitled"}</span>
      <span className="t-row-meta">
        {child ? <span>{row.agentType ?? "subagent"}</span> : <HarnessGlyph harness={row.harness} />}
        {!child && <span className="t-proj">{folderName(row.projectPath)}</span>}
        {runnerLabel && <span className="t-proj">· {runnerLabel}</span>}
        <span>· {shortAgo(row.updatedAt, now)}</span>
        {(!!row.requests || row.status === "waiting") && <span className="t-needs">· Needs you</span>}
        <StatusDot status={row.status} requests={row.requests} />
      </span>
    </button>
  );
}
