import { useEffect, useState } from "react";
import type { SessionDiff } from "../shared/protocol";
import { rpc } from "../store";

export function ChangesPanel({ sessionId }: { sessionId: string }) {
  const [result, setResult] = useState<SessionDiff>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    let live = true;
    let inFlight = false;
    const refresh = async (initial = false) => {
      if (inFlight) return;
      inFlight = true;
      if (initial) setLoading(true);
      try {
        const next = await rpc("getSessionDiff", { sessionId });
        if (live) {
          setResult(next);
          setError(undefined);
          setUpdatedAt(Date.now());
        }
      } catch (e: any) {
        if (live) setError(e?.message ?? String(e));
      } finally {
        inFlight = false;
        if (live && initial) setLoading(false);
      }
    };
    void refresh(true);
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [sessionId, refreshVersion]);

  const files = result?.files ?? [];
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);

  return (
    <section className="changes-panel">
      <div className="changes-heading">
        <div>
          <h2>Session changes</h2>
          <div className="hint">
            {loading && !result
              ? "Loading working tree…"
              : result
                ? `${files.length} ${files.length === 1 ? "file" : "files"} · +${additions} −${deletions} · ${result.base === "session" ? "since session start" : result.base === "HEAD" ? "against HEAD" : "against empty tree"}`
                : "Changes could not be loaded."}
            {updatedAt > 0 && <span> · refreshed {new Date(updatedAt).toLocaleTimeString()}</span>}
          </div>
        </div>
        <div className="changes-actions">
          <span className="changes-live" title="Tracked and non-ignored files; refreshes every 10 seconds">Git diff · 10s</span>
          <button className="btn" onClick={() => setRefreshVersion((v) => v + 1)}>Refresh</button>
        </div>
      </div>

      {result?.base === "HEAD" && <div className="changes-note">No Tether baseline is saved for this session yet; showing the project’s current changes against HEAD.</div>}
      {result?.base === "empty" && <div className="changes-note">No Tether baseline or HEAD commit is available yet; showing files against an empty Git tree.</div>}
      {error && <div className="changes-error">{error}</div>}
      {result?.truncated && <div className="changes-note">The list or patch output is capped to keep the viewer responsive.</div>}

      {result && files.length === 0 && <div className="empty changes-empty">No file changes relative to this diff baseline.</div>}
      {files.map((file, index) => (
        <details className="change-file" key={`${file.path}-${index}`} open={index === 0 || undefined}>
          <summary>
            <span className={`change-status ${file.status}`}>{statusLabel(file.status)}</span>
            <span className="change-path mono" title={file.path}>{file.path}</span>
            <span className="change-counts"><i>+{file.additions}</i><b>−{file.deletions}</b></span>
          </summary>
          {file.patch ? (
            <div className="session-diff">
              {file.patch.split("\n").map((line, i) => (
                <div key={i} className={lineClass(line)}>{line || " "}</div>
              ))}
              {file.truncated && <div className="diff-truncated">… patch truncated</div>}
            </div>
          ) : (
            <div className="changes-note">No text patch is available for this file.</div>
          )}
        </details>
      ))}
    </section>
  );
}

function statusLabel(status: string) {
  return status === "added" ? "A" : status === "deleted" ? "D" : status === "typechanged" ? "T" : status === "modified" ? "M" : "?";
}

function lineClass(line: string) {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("\\")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (line.startsWith("@@")) return "hunk";
  return "ctx";
}
