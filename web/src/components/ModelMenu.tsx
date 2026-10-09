import { useEffect, useRef, useState } from "react";
import { formatEntry, type HarnessId, type LiveState, type ModelProfile, type ModelRef } from "../shared/protocol";
import { act, rpc } from "../store";
import { ChainEditor } from "./ChainEditor";

export function useClickAway(onAway: () => void) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onAway();
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onAway]);
  return ref;
}

export function PickMenu({
  label,
  value,
  options,
  onPick,
  className,
  describe,
}: {
  label: string;
  value: string;
  options: string[];
  onPick: (v: string) => void;
  className?: string;
  describe?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useClickAway(() => setOpen(false));
  return (
    <span ref={ref} className={`pill ${className ?? ""}`} style={{ cursor: "pointer" }} onClick={() => setOpen(!open)}>
      {label} <b>{value}</b> ▾
      {open && (
        <div className="pop" style={{ width: describe ? 300 : 220 }} onClick={(e) => e.stopPropagation()}>
          {options.map((o) => (
            <button
              key={o}
              className={`item${o === value ? " on" : ""}`}
              style={describe ? { flexDirection: "column", alignItems: "flex-start", gap: 0 } : undefined}
              onClick={() => {
                onPick(o);
                setOpen(false);
              }}
            >
              {o}
              {describe?.[o] && <small style={{ color: "var(--dim)" }}>{describe[o]}</small>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** Loads the model lists of every harness (for building cross-harness chains). */
export function useModels(harnesses: HarnessId[], sessionId?: string) {
  const [models, setModels] = useState<Record<string, ModelRef[]>>({});
  useEffect(() => {
    for (const h of harnesses)
      rpc("listModels", { harness: h, sessionId })
        .then((r) => setModels((m) => ({ ...m, [h]: r.models })))
        .catch(() => {});
  }, [harnesses.join(","), sessionId]);
  return models;
}

/**
 * Model picker plus this session's fallback chain: pick one model, apply a profile, or edit the
 * order (entries may name another harness; moving to one hands the conversation off).
 */
export function ModelMenu({ sessionId, harness, state }: { sessionId: string; harness: HarnessId; state: LiveState }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const addHarness = harness;
  const ref = useClickAway(() => setOpen(false));
  const models = useModels(open ? [harness] : [], sessionId);
  useEffect(() => {
    if (open) rpc("getProfiles", {}).then(setProfiles).catch(() => {});
  }, [open]);

  const chain = state.chain ?? [];
  const cur = state.model ?? "default";
  const setChain = (c: string[], preferEarlier = state.preferEarlier) => act("setChain", { sessionId, chain: c, preferEarlier });
  const list = (models[addHarness] ?? []).filter((m) => (m.id + " " + (m.label ?? "")).toLowerCase().includes(filter.toLowerCase()));

  return (
    <span ref={ref} className="pill" style={{ cursor: "pointer" }} onClick={() => setOpen(!open)}>
      {chain.length ? "⇄" : "◇"} {state.profile && <b>{state.profile}</b>}
      {state.profile && " · "}
      <b>{cur}</b> ▾
      {open && (
        <div className="pop" onClick={(e) => e.stopPropagation()}>
          <h4>Fallback order for this session</h4>
          <ChainEditor chain={chain} onChange={(c) => setChain(c)} sessionId={sessionId} fallback={harness} current={formatEntry({ harness, model: cur })} />
          {chain.length > 0 && (
            <label className="item" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={state.preferEarlier !== false} onChange={(e) => setChain(chain, e.target.checked)} />
              Return to earlier entries when their limit resets
            </label>
          )}
          {profiles.length > 0 && (
            <>
              <h4 style={{ marginTop: 10 }}>Apply a profile</h4>
              <div className="seg" style={{ padding: "0 4px 6px" }}>
                {profiles.map((p) => (
                  <button key={p.name} className={state.profile === p.name ? "on" : ""} onClick={() => act("setModel", { sessionId, profile: p.name })} title={p.chain.join(" → ")}>
                    {p.name}
                  </button>
                ))}
              </div>
            </>
          )}
          <h4 style={{ marginTop: 10 }}>Switch this session's model</h4>
          <input type="text" placeholder="Filter models…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginBottom: 6 }} />
          <div className="list">
            {list.slice(0, 200).map((m) => {
              return (
                <div key={m.id} className="chainrow">
                  <span className="mono grow" style={{ overflow: "hidden", textOverflow: "ellipsis" }} title={m.label}>
                    {m.id}
                  </span>
                  <button className="btn" style={{ padding: "2px 8px" }} disabled={m.id === cur} onClick={() => act("setModel", { sessionId, model: m.id })}>
                    {m.id === cur ? "current" : "Use"}
                  </button>
                </div>
              );
            })}
            {!models[addHarness] && <div className="hint" style={{ padding: 6 }}>Loading…</div>}
          </div>
        </div>
      )}
    </span>
  );
}
