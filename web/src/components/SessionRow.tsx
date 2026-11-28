import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "@astryxdesign/core/Icon";
import { ArchiveBoxIcon, ArrowUturnLeftIcon } from "@heroicons/react/24/outline";
import { HARNESS_LABELS, type Billing, type HarnessId, type RunStatus } from "../../../shared/transcript";
import { rpc } from "../connection";
import { openSession } from "../route";
import { folderName, projectOf, type Row } from "../sessionList";
import { asksWorktree } from "../runners";
import { watchingChip, watchingTitle } from "../watching";
import { setArchived as saveArchived, setPinned as savePinned, useStore } from "../store";

/** "now", "5m", "3h", "2d", "Oct 3" */
export function shortAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const CLAUDE_PATH =
  "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z";

const CODEX_PATH =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

const ANTIGRAVITY_PATH =
  "M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z";

export function HarnessGlyph({ harness }: { harness: HarnessId }) {
  const gradId = useId();
  let icon: React.ReactNode;
  if (harness === "claude") {
    icon = (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d={CLAUDE_PATH} fill="#D97757" />
      </svg>
    );
  } else if (harness === "codex") {
    icon = (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d={CODEX_PATH} fill="currentColor" />
      </svg>
    );
  } else if (harness === "antigravity") {
    icon = (
      <svg viewBox="-1 0 26 25" aria-hidden="true">
        <defs>
          <linearGradient id={gradId} x1="10%" y1="90%" x2="90%" y2="10%">
            <stop offset="0%" stopColor="#00B95C" />
            <stop offset="35%" stopColor="#FBBC04" />
            <stop offset="68%" stopColor="#FC413D" />
            <stop offset="100%" stopColor="#3186FF" />
          </linearGradient>
        </defs>
        <path d={ANTIGRAVITY_PATH} fill={`url(#${gradId})`} />
      </svg>
    );
  } else {
    icon = "•";
  }
  return (
    <span className={`t-glyph t-glyph-${harness}`} title={HARNESS_LABELS[harness]} aria-label={HARNESS_LABELS[harness]} role="img">
      {icon}
    </span>
  );
}

const STATUS_LABEL: Record<RunStatus, string> = { running: "Working", waiting: "Needs you", idle: "Idle" };

export function StatusDot({ status, requests }: { status: RunStatus; requests?: number }) {
  const s = requests ? "waiting" : status;
  if (s === "idle") return null;
  return <span className={`t-dot ${s}`} role="img" aria-label={STATUS_LABEL[s]} title={STATUS_LABEL[s]} />;
}

export function UnknownBillingMarker({ billing }: { billing?: Billing }) {
  if (!billing || billing.kind === "unknown") return <span className="t-billing-unknown" title="Billing unknown" aria-label="Billing unknown">?</span>;
  return null;
}

/** `canPin`: its runner takes pinSession (runners.ts canPin). */
/** `hideProject`: shown under its project's subheader (Recent), so the meta line leaves it out. */
export function SessionRow({ row, now, selected, child, runnerLabel, canPin, hideProject }: { row: Row; now: number; selected: boolean; child?: boolean; runnerLabel?: string; canPin?: boolean; hideProject?: boolean }) {
  const close = () => useStore.setState({ sidebarOpen: false });
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleBusy, setTitleBusy] = useState(false);
  const [renameError, setRenameError] = useState<string>();
  const [archived, setArchived] = useState(!!row.archived);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string>();
  const [pinned, setPinned] = useState(!!row.pinned);
  const [pinBusy, setPinBusy] = useState(false);
  const pinnable = !!canPin && !child;
  const titleInput = useRef<HTMLInputElement>(null);
  const editing = useRef(false);
  // Listed under its main checkout (sessionList.ts projectOf): the worktree's branch tells it apart.
  const wt = !child && row.worktreeOf ? row.worktreeBranch || folderName(row.projectPath) : undefined;

  useEffect(() => {
    if (editingTitle) {
      titleInput.current?.focus();
      titleInput.current?.select();
    }
  }, [editingTitle]);
  useEffect(() => setArchived(!!row.archived), [row.archived]);
  useEffect(() => setPinned(!!row.pinned), [row.pinned]);
  // The error is shown once: gone after a few seconds or at the next click or key.
  useEffect(() => {
    if (!archiveError) return;
    const clear = () => setArchiveError(undefined);
    const t = setTimeout(clear, 5000);
    document.addEventListener("pointerdown", clear, true);
    document.addEventListener("keydown", clear, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener("pointerdown", clear, true);
      document.removeEventListener("keydown", clear, true);
    };
  }, [archiveError]);

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
    // A missing row is only what was saved: nothing to rename or open.
    if (child || row.missing || editing.current || titleBusy) return;
    setRenameError(undefined);
    editing.current = true;
    setEditingTitle(true);
  };
  const toggleArchive = async () => {
    if (archiveBusy) return;
    // In a worktree Tether made: ask what becomes of it first (ArchiveWorktreeDialog).
    if (asksWorktree(useStore.getState().runners, row.runnerId, { ...row, archived })) return useStore.setState({ archiveAsk: { runnerId: row.runnerId, session: row } });
    setArchiveBusy(true);
    setArchiveError(undefined);
    try {
      await saveArchived(row.runnerId, row.id, !archived, undefined, "the sidebar row's button");
      setArchived(!archived);
    } catch (e) {
      setArchiveError(`Archive failed: ${(e as Error).message}`);
    } finally {
      setArchiveBusy(false);
    }
  };

  // Errors share the archive button's line: one row action at a time.
  const togglePin = async () => {
    if (pinBusy) return;
    setPinBusy(true);
    setArchiveError(undefined);
    try {
      await savePinned(row.runnerId, row.id, !pinned, !!archived);
      setPinned(!pinned);
      if (!pinned) setArchived(false);
    } catch (e) {
      setArchiveError(`${pinned ? "Unpin" : "Pin"} failed: ${(e as Error).message}`);
    } finally {
      setPinBusy(false);
    }
  };

  return (
    <div
      className={`t-row${child ? " t-child" : ""}${row.unread ? " unread" : ""}${selected ? " selected" : ""}${pinnable ? " t-pinnable" : ""}${pinnable && pinned ? " t-pinned" : ""}${row.missing ? " t-missing" : ""}`}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("input, .t-row-archive, .t-row-pin")) return;
        beginRename();
      }}
    >
      <button
        type="button"
        className="t-row-open"
        aria-label={`Open session: ${row.title || "Untitled"}`}
        aria-current={selected ? "page" : undefined}
        disabled={row.missing}
        onKeyDown={(e) => {
          if (e.key === "F2" && !child) {
            e.preventDefault();
            beginRename();
          }
        }}
        onClick={() => {
          if (row.missing) return;
          openSession(row.runnerId, row.id);
          close();
        }}
      />
      <div className="t-row-content">
        <span className="t-row-title t-row-title-editor">
          <UnknownBillingMarker billing={row.billing} />
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
          {child && row.spawned ? (
            // A session another session's agent started (SPEC §6a): its harness, and who made it.
            <>
              <HarnessGlyph harness={row.harness} />
              <span className="t-spawned">started by agent</span>
            </>
          ) : child ? <span>{row.agentType ?? "subagent"}</span> : <HarnessGlyph harness={row.harness} />}
          {!child && !hideProject && <span className="t-proj">{folderName(projectOf(row))}</span>}
          {wt && <span className="t-proj t-wt" title={`In the worktree ${row.projectPath}`}>{hideProject ? "" : "· "}⑂ {wt}</span>}
          {runnerLabel && <span className="t-proj">{hideProject && !wt ? "" : "· "}{runnerLabel}</span>}
          <span>· {shortAgo(row.updatedAt, now)}</span>
          {archived && <span className="t-archived">· Archived</span>}
          {row.missing && <span className="t-archived">· Not found on this computer</span>}
          {(!!row.requests || row.status === "waiting") && <span className="t-needs">· Needs you</span>}
          {row.unread && !row.requests && row.status !== "waiting" && !(row.unread === "finished" && (row.backgroundSubagents || row.watching)) && <span className={`t-unread ${row.unread}`}>· {row.unread === "failed" ? "Failed" : "Finished"}</span>}
          {row.watching && row.status === "idle" && !row.requests && <span className="t-watching" title={watchingTitle(row.watching)}>· {watchingChip(row.watching, now)}</span>}
          <StatusDot status={row.status} requests={row.requests} />
        </span>
        {pinnable && (
          <button
            type="button"
            className={`t-row-archive t-row-pin${pinned ? " on" : ""}`}
            aria-label={`Pin session: ${row.title || "Untitled"}`}
            aria-pressed={pinned}
            title={`${pinned ? "Unpin" : "Pin"} session`}
            disabled={pinBusy}
            onClick={(e) => {
              e.stopPropagation();
              void togglePin();
            }}
          >
            <PinIcon filled={pinned} />
          </button>
        )}
        {!child && !row.missing && (
          <button
            type="button"
            className="t-row-archive"
            aria-label={`${archived ? "Unarchive" : "Archive"} session: ${row.title || "Untitled"}`}
            title={`${archived ? "Unarchive" : "Archive"} session`}
            disabled={archiveBusy}
            onClick={(e) => {
              e.stopPropagation();
              void toggleArchive();
            }}
          >
            <Icon icon={archived ? ArrowUturnLeftIcon : ArchiveBoxIcon} size="sm" />
          </button>
        )}
        {renameError && <span className="t-row-rename-error" role="status">Rename failed: {renameError}</span>}
        {archiveError && <span className="t-row-archive-error" role="status">{archiveError}</span>}
      </div>
    </div>
  );
}

/** A pushpin in Heroicons' outline style (Heroicons has none); filled when pinned. */
function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 4.5l-4 4-4 1.5-1.5 1.5 7 7 1.5-1.5 1.5-4 4-4z" />
      <path d="M9 15l-4.5 4.5M14.5 4l5.5 5.5" />
    </svg>
  );
}
