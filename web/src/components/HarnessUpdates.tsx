import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { statusLabel, type HarnessReport, type HarnessVersion } from "../../../shared/harnessUpdates";
import { rpc } from "../connection";
import { canUpdate, checkedAgo, METHOD_LABELS, runLine, updateAllTargets, updating } from "../harnessUpdates";
import { useStore } from "../store";
import { useNow } from "./useNow";

interface RunnerState {
  report?: HarnessReport;
  error?: string;
  checking?: boolean;
}

const POLL_MS = 1500;

/** Settings → Updates: every runner's harnesses, their versions, and updating them. */
export function HarnessUpdates() {
  const runners = useStore((s) => s.runners);
  const link = useStore((s) => s.link);
  const now = useNow();
  const [state, setState] = useState<Record<string, RunnerState>>({});
  const [starting, setStarting] = useState(false);
  const patch = (id: string, p: RunnerState) => setState((s) => ({ ...s, [id]: { ...s[id], ...p } }));
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const load = useCallback(async (runnerId: string, refresh: boolean, quiet = false) => {
    if (!quiet) patch(runnerId, { checking: true, error: undefined });
    try {
      const report = await rpc(runnerId, "harnessVersions", { refresh });
      if (alive.current) patch(runnerId, { report, checking: false, error: undefined });
    } catch (e) {
      const msg = (e as Error)?.message ?? "";
      if (alive.current) patch(runnerId, { checking: false, error: /doesn't know/.test(msg) ? "This runner can't check for updates. Update and restart it." : msg || "Couldn't check." });
    }
  }, []);

  const online = runners.filter((r) => r.online);
  const onlineKey = online.map((r) => r.id).join(",");
  // The last check (cached on the runner for a few minutes) as the page opens.
  useEffect(() => {
    if (link !== "open") return;
    for (const r of online) if (!state[r.id]?.report) void load(r.id, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, onlineKey]);

  // While an update runs, follow it.
  const busyRunners = online.filter((r) => state[r.id]?.report?.harnesses.some(updating)).map((r) => r.id);
  const busyKey = busyRunners.join(",");
  useEffect(() => {
    if (!busyRunners.length || link !== "open") return;
    const t = setInterval(() => busyRunners.forEach((id) => void load(id, false, true)), POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busyKey, link]);

  const update = async (runnerId: string, id: string) => {
    try {
      patch(runnerId, { report: await rpc(runnerId, "harnessUpdate", { id }), error: undefined });
    } catch (e) {
      patch(runnerId, { error: (e as Error)?.message || "Couldn't start the update." });
    }
  };
  const isOnline = (id: string) => online.some((r) => r.id === id);
  const targets = updateAllTargets(Object.fromEntries(Object.entries(state).map(([k, v]) => [k, v.report])), isOnline);
  const updateAll = async () => {
    setStarting(true);
    try {
      for (const t of targets) await update(t.runnerId, t.id);
    } finally {
      setStarting(false);
    }
  };
  const disabled = link !== "open";

  return <>
    <Heading level={2}>Updates</Heading>
    <div className="t-updates-actions">
      <Button label={online.length > 1 ? "Check all runners" : "Check for updates"} variant="secondary" isDisabled={disabled || !online.length || online.some((r) => state[r.id]?.checking)} onClick={() => online.forEach((r) => void load(r.id, true))} />
      {targets.length > 0 && <Button label={`Update all (${targets.length})`} variant="primary" isDisabled={disabled || starting} onClick={() => void updateAll()} />}
    </div>
    {!runners.length && <div className="t-inline-status">No runner connected.</div>}
    {runners.map((r) => {
      const s = state[r.id] ?? {};
      return (
        <section key={r.id} className="t-updates-runner" aria-label={r.name || r.id}>
          <div className="t-updates-head">
            <Heading level={3}>{r.name || r.id}</Heading>
            <span className="t-credential-status">{!r.online ? "Offline" : s.checking ? "Checking…" : s.report ? checkedAgo(s.report.checkedAt, now) : ""}</span>
            {runners.length > 1 && r.online && <Button label="Check for updates" variant="secondary" size="sm" isDisabled={disabled || s.checking} onClick={() => void load(r.id, true)} />}
          </div>
          {s.error && <div className="t-inline-status error" role="alert">{s.error}</div>}
          {r.online && s.report && <UpdatesTable report={s.report} disabled={disabled} onUpdate={(id) => void update(r.id, id)} />}
          {r.online && !s.report && !s.error && <div className="t-inline-status">Checking…</div>}
        </section>
      );
    })}
  </>;
}

function UpdatesTable({ report, disabled, onUpdate }: { report: HarnessReport; disabled: boolean; onUpdate: (id: string) => void }) {
  return (
    <table className="t-updates-table">
      <thead>
        <tr><th>Harness</th><th>Installed</th><th>Latest</th><th>Status</th><th aria-label="Actions" /></tr>
      </thead>
      {report.harnesses.map((h) => <Row key={h.id} h={h} disabled={disabled} onUpdate={onUpdate} />)}
    </table>
  );
}

function Row({ h, disabled, onUpdate }: { h: HarnessVersion; disabled: boolean; onUpdate: (id: string) => void }) {
  const line = runLine(h);
  const u = h.update;
  const tone = h.status === "available" ? (h.method === "bundled" ? "muted" : "available") : h.status === "current" ? "current" : "muted";
  return (
    <tbody className="t-updates-row">
      <tr>
        <td className="t-updates-name">
          <span>{h.name}</span>
          <span className="t-updates-method" title={h.path}>{METHOD_LABELS[h.method]}</span>
        </td>
        <td data-label="Installed">{h.installed ?? "—"}</td>
        <td data-label="Latest">{h.latest ?? "—"}</td>
        <td data-label="Status"><span className={`t-updates-status ${tone}`} title={h.error}>{statusLabel(h)}</span></td>
        <td className="t-updates-action">
          {canUpdate(h) && <Button label="Update" variant="primary" size="sm" isDisabled={disabled} tooltip={h.command} onClick={() => onUpdate(h.id)} />}
        </td>
      </tr>
      {(h.error || line) && (
        <tr className="t-updates-detail">
          <td colSpan={5}>
            {h.error && !line && <div className="t-updates-note">{h.error}</div>}
            {line && <div className={`t-updates-result ${u?.state === "failed" ? "fail" : u?.state === "done" ? "ok" : ""}`}>{line}</div>}
            {u && u.state !== "queued" && (
              <details className="t-updates-output" open={u.state === "running" || u.state === "failed"}>
                <summary>{u.command}</summary>
                <pre>{u.output.trim() || (u.state === "running" ? "…" : "(no output)")}</pre>
              </details>
            )}
            {u?.state === "done" && h.note && <div className="t-updates-note">{h.note}</div>}
          </td>
        </tr>
      )}
    </tbody>
  );
}
