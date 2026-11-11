// Send to all (SPEC §9a): one message from you, queued in every session the picker matches, as your
// own words. Each session's queue applies: a running turn gets it afterwards, never steered. No
// confirm step: nothing goes until you press Send, and the count sits beside it.

import { useEffect, useMemo, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { matching, type BroadcastFilter } from "../../../shared/peers";
import { HARNESS_LABELS, type HarnessId, type SessionSummary } from "../../../shared/transcript";
import type { OpResult } from "../../../shared/protocol";
import { rpc } from "../connection";
import { openSession } from "../route";
import { folderName, isHomeChat } from "../sessionList";
import { useStore } from "../store";

const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
const NONE: Record<string, SessionSummary> = {};
const plural = (n: number) => `${n} session${n === 1 ? "" : "s"}`;

export function SendToAll() {
  const open = useStore((s) => s.sendAllOpen);
  const runners = useStore((s) => s.runners);
  const online = runners.filter((r) => r.online);
  const [runnerId, setRunnerId] = useState<string>();
  const rid = runnerId && online.some((r) => r.id === runnerId) ? runnerId : online[0]?.id;
  const rows = useStore((s) => (rid ? (s.summaries[rid]?.sessions ?? NONE) : NONE));
  // The Home agent's chat is never one of them (the runner leaves it out too).
  const all = useMemo(() => matching(Object.values(rows)).filter((s) => !isHomeChat(rid ?? "", s.projectPath)), [rows, rid]);
  const [filter, setFilter] = useState<BroadcastFilter>({});
  // Each time it opens: every session again, so a filter left from before never narrows it unseen.
  useEffect(() => {
    if (open) setFilter({});
  }, [open]);
  const projects = useMemo(() => [...new Set(all.map((s) => s.projectPath))].sort((a, b) => folderName(a).localeCompare(folderName(b))), [all]);
  const harnesses = useMemo(() => (["claude", "codex"] as HarnessId[]).filter((h) => all.some((s) => s.harness === h)), [all]);
  // A picked project or agent that has no session any more (or isn't shown) narrows nothing.
  const used = useMemo<BroadcastFilter>(() => {
    const { projectPath, harness, ...rest } = filter;
    return { ...rest, ...(projectPath && projects.includes(projectPath) ? { projectPath } : {}), ...(harness && harnesses.length > 1 && harnesses.includes(harness) ? { harness } : {}) };
  }, [filter, projects, harnesses]);
  const targets = useMemo(() => matching(all, used), [all, used]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<OpResult<"broadcast">>();

  const close = () => {
    useStore.setState({ sendAllOpen: false });
    setResult(undefined);
    setError(undefined);
  };
  const send = async () => {
    if (!rid || !text.trim() || !targets.length || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setResult(await rpc(rid, "broadcast", { text, filter: used }));
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const set = (patch: Partial<BroadcastFilter>) => {
    setFilter((f) => {
      const next = { ...f, ...patch };
      for (const k of Object.keys(next) as (keyof BroadcastFilter)[]) if (!next[k]) delete next[k];
      return next;
    });
    setResult(undefined);
  };

  return (
    <Dialog isOpen={open} onOpenChange={(o) => !o && close()} width={520} purpose="form">
      <DialogHeader title="Send to all" subtitle="Your message, in each session's queue" onOpenChange={(o) => !o && close()} />
      <div className="t-form" style={{ padding: 16 }}>
        {online.length > 1 && (
          <label>
            <span className="t-field-label">Runner</span>
            <select className="t-select" value={rid} onChange={(e) => (setRunnerId(e.target.value), setFilter({}))}>
              {online.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name || r.id}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="t-sendall-filters">
          <label>
            <span className="t-field-label">Project</span>
            <select className="t-select" value={used.projectPath ?? ""} onChange={(e) => set({ projectPath: e.target.value || undefined })}>
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p} value={p}>
                  {folderName(p)}
                </option>
              ))}
            </select>
          </label>
          {harnesses.length > 1 && (
            <label>
              <span className="t-field-label">Agent</span>
              <select className="t-select" value={used.harness ?? ""} onChange={(e) => set({ harness: (e.target.value || undefined) as HarnessId | undefined })}>
                <option value="">Any</option>
                {harnesses.map((h) => (
                  <option key={h} value={h}>
                    {HARNESS_LABELS[h]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span className="t-field-label">Status</span>
            <select className="t-select" value={filter.status ?? ""} onChange={(e) => set({ status: (e.target.value || undefined) as BroadcastFilter["status"] })}>
              <option value="">Any</option>
              <option value="idle">Idle</option>
              <option value="working">Working</option>
              <option value="waiting">Waiting on you</option>
            </select>
          </label>
        </div>
        <textarea
          className="t-search t-sendall-text"
          rows={4}
          placeholder="Message to every session"
          aria-label="Message to every session"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (result) setResult(undefined);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && (!coarse() || e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {error && <div className="t-form-error">{error}</div>}
        {result && (
          <div className="t-sendall-result" role="status">
            <span>Queued in {plural(result.queued.length)}.</span>
            <span className="t-sendall-links">
              {result.queued.map((q) => (
                <button
                  type="button"
                  key={q.sessionId}
                  className="t-link"
                  onClick={() => {
                    close();
                    openSession(rid!, q.sessionId);
                  }}
                >
                  {q.title || "Untitled"}
                </button>
              ))}
            </span>
            {result.failed.map((f) => (
              <span key={f.sessionId} className="t-form-error">
                Not sent to {f.title || "Untitled"}: {f.error}
              </span>
            ))}
          </div>
        )}
        <div className="t-sendall-foot">
          <span className="t-inline-status">{targets.length ? `${plural(targets.length)}` : "No session matches"}</span>
          <Button label="Cancel" variant="secondary" onClick={close} />
          <Button label={busy ? "Sending…" : "Send"} variant="primary" isDisabled={!rid || !text.trim() || !targets.length || busy} onClick={() => void send()} />
        </div>
      </div>
    </Dialog>
  );
}
