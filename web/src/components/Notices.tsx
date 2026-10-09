import { useEffect, useRef, useState } from "react";
import { markNoticeRead, refreshNotices, selectSession, useStore } from "../store";
import { fmtClock } from "../util";

/** The bell: what your agents asked, finished or got stuck on, newest first. */
export function NoticeBell() {
  const notices = useStore((s) => s.notices);
  const noticesSeen = useStore((s) => s.noticesSeen);
  const noticesRead = useStore((s) => s.noticesRead);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isRead = (id: string, ts: number) => ts <= noticesSeen || noticesRead.includes(id);
  const unseen = notices.filter((n) => !isRead(n.id, n.ts)).length;

  useEffect(() => {
    if (!open) return;
    refreshNotices();
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="bell" ref={ref}>
      <button
        className="iconbtn"
        title="Notifications"
        onClick={() => {
          setOpen(!open);
        }}
      >
        🔔{unseen > 0 && <span className="badge">{unseen > 9 ? "9+" : unseen}</span>}
      </button>
      {open && (
        <div className="bellmenu">
          <div className="bellhd">
            <span className="grow">Notifications</span>
            <button
              className="link"
              onClick={() => {
                setOpen(false);
                useStore.setState({ dialog: "settings" });
              }}
            >
              Settings
            </button>
          </div>
          {notices.length === 0 && <div className="hint" style={{ padding: 10 }}>Nothing yet. Questions, finished turns and blocks show up here.</div>}
          {notices.slice(0, 50).map((n) => (
            <button
              key={n.id}
              className={`notice ${n.kind}${isRead(n.id, n.ts) ? " read" : " unread"}`}
              onClick={() => {
                markNoticeRead(n.id);
                setOpen(false);
                if (n.sessionId) selectSession(n.sessionId);
              }}
            >
              <span
                className={`attention-indicator ${n.kind === "finished" ? "finished" : "urgent"} ${isRead(n.id, n.ts) ? "read" : "unread"}`}
                title={`${n.kind === "finished" ? "Completed" : n.kind === "question" ? "Question" : "Blocked"} · ${isRead(n.id, n.ts) ? "Viewed" : "Ready to view"}`}
                aria-hidden="true"
              />
              <span className="grow">
                <span className="nt">{n.title}</span>
                <span className="nb">{n.body}</span>
              </span>
              <span className="when">{fmtClock(n.ts)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
