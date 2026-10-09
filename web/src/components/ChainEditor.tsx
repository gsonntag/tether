import { useMemo, useState } from "react";
import { formatEntry, HARNESSES, parseEntry, usageProvider, type HarnessId, type ModelRef } from "../shared/protocol";
import { useStore } from "../store";
import { badge } from "../util";
import { useModels } from "./ModelMenu";

/** Groups a harness's models by provider prefix ("openai-codex/gpt-6-luna" → "openai-codex"). */
function groups(models: ModelRef[]): [string, ModelRef[]][] {
  const g = new Map<string, ModelRef[]>();
  for (const m of models) {
    const k = m.id.includes("/") ? m.id.slice(0, m.id.indexOf("/")) : "";
    g.set(k, [...(g.get(k) ?? []), m]);
  }
  return [...g.entries()];
}

function useAvailable(): HarnessId[] {
  const runner = useStore((s) => s.runners.find((r) => r.id === s.runnerId));
  return runner?.harnesses ?? [];
}

/**
 * Edits a fallback chain: ordered harness:model entries with dropdowns for adding, a check on each
 * entry (harness installed, model known, current plan usage) and the full list of valid entries.
 */
export function ChainEditor({
  chain,
  onChange,
  sessionId,
  fallback,
  current,
}: {
  chain: string[];
  onChange: (c: string[]) => void;
  sessionId?: string;
  /** harness of entries written without a "harness:" prefix (the session's own) */
  fallback?: HarnessId;
  /** the entry the session runs on now */
  current?: string;
}) {
  const available = useAvailable();
  const models = useModels(available, sessionId);
  const usage = useStore((s) => s.usage);
  const [h, setH] = useState<HarnessId | "">("");
  const [m, setM] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState("");

  const harness = (h || available[0] || "claude-code") as HarnessId;
  const list = models[harness] ?? [];
  const model = m && list.some((x) => x.id === m) ? m : (list[0]?.id ?? "");

  const move = (i: number, d: number) => {
    const c = [...chain];
    const [x] = c.splice(i, 1);
    c.splice(i + d, 0, x!);
    onChange(c);
  };
  const add = (entry: string) => !chain.includes(entry) && onChange([...chain, entry]);

  const check = (raw: string) => {
    const { harness: eh, model: em } = parseEntry(raw, fallback ?? "claude-code");
    const known = !!fallback || HARNESSES.some((x) => raw.startsWith(x.id + ":"));
    if (!known) return { bad: `Unknown harness. Use one of: ${HARNESSES.map((x) => x.id).join(", ")}` };
    if (!available.includes(eh)) return { bad: `${HARNESSES.find((x) => x.id === eh)?.label} is not installed on this runner` };
    const ms = models[eh];
    if (ms && em && em !== "default" && !ms.some((x) => x.id === em || x.label === em))
      return { warn: `Not in ${HARNESSES.find((x) => x.id === eh)?.label}'s model list (an alias may still work)` };
    const label = ms?.find((x) => x.id === em)?.label;
    const prov = usageProvider(eh, em);
    const u = prov && usage?.providers.find((p) => p.provider === prov);
    const w5 = u?.windows.find((w) => w.label === "5h");
    const wk = u?.windows.find((w) => w.label === "Weekly");
    return { label, usage: u && !u.error ? `${u.label}: 5h ${w5?.percent ?? "–"}% · wk ${wk?.percent ?? "–"}%` : undefined };
  };

  const all = useMemo(() => {
    const f = filter.toLowerCase();
    return available.map((hid) => ({
      harness: hid,
      models: (models[hid] ?? []).filter((x) => !f || `${hid}:${x.id} ${x.label ?? ""}`.toLowerCase().includes(f)),
    }));
  }, [available, models, filter]);

  return (
    <div className="chained">
      {chain.length === 0 && <div className="hint" style={{ margin: "0 0 6px" }}>Empty: a usage limit just stops the session.</div>}
      <ol className="chainlist">
        {chain.map((raw, i) => {
          const { harness: eh, model: em } = parseEntry(raw, fallback ?? "claude-code");
          const c = check(raw);
          const isCur = current !== undefined && formatEntry({ harness: eh, model: em }) === current;
          return (
            <li key={raw + i} className={c.bad ? "bad" : c.warn ? "warn" : ""}>
              <span className="n">{i + 1}</span>
              <span className={`h ${eh}`}>{badge(eh)}</span>
              <span className="grow ce-main">
                <span className="mono">{em || "default"}</span>
                {isCur && <span className="cur">current</span>}
                {c.label && c.label !== em && <span className="ce-sub">{c.label}</span>}
                {(c.bad || c.warn) && <span className="ce-sub ce-err">{c.bad ?? c.warn}</span>}
                {c.usage && <span className="ce-sub">{c.usage}</span>}
              </span>
              <button type="button" className="x" disabled={i === 0} onClick={() => move(i, -1)} title="Up">
                ↑
              </button>
              <button type="button" className="x" disabled={i === chain.length - 1} onClick={() => move(i, 1)} title="Down">
                ↓
              </button>
              <button type="button" className="x" onClick={() => onChange(chain.filter((_, j) => j !== i))} title="Remove">
                ✕
              </button>
            </li>
          );
        })}
      </ol>

      <div className="ce-add">
        <select value={harness} onChange={(e) => (setH(e.target.value as HarnessId), setM(""))}>
          {HARNESSES.map((x) => (
            <option key={x.id} value={x.id} disabled={!available.includes(x.id)}>
              {x.label}
              {available.includes(x.id) ? "" : " (not installed)"}
            </option>
          ))}
        </select>
        <select value={model} onChange={(e) => setM(e.target.value)} disabled={!list.length}>
          {!models[harness] && <option>Loading…</option>}
          {groups(list).map(([g, ms]) =>
            g ? (
              <optgroup key={g} label={g}>
                {ms.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.id.slice(g.length + 1)}
                    {x.label && x.label !== x.id ? ` · ${x.label}` : ""}
                  </option>
                ))}
              </optgroup>
            ) : (
              ms.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.id}
                  {x.label && x.label !== x.id ? ` · ${x.label}` : ""}
                </option>
              ))
            ),
          )}
        </select>
        <button type="button" className="btn" disabled={!model || chain.includes(formatEntry({ harness, model }))} onClick={() => add(formatEntry({ harness, model }))}>
          Add
        </button>
      </div>

      <button type="button" className="linkbtn" style={{ marginTop: 6 }} onClick={() => setShowAll(!showAll)}>
        {showAll ? "Hide the list of valid entries" : `Show every valid entry (${all.reduce((n, g) => n + (models[g.harness]?.length ?? 0), 0)})`}
      </button>
      {showAll && (
        <div className="ce-all">
          <input type="text" placeholder="Filter, e.g. codex, opus, azure…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {all.map((g) => (
            <div key={g.harness}>
              <div className="ce-h">
                <span className={`h ${g.harness}`}>{badge(g.harness)}</span> {HARNESSES.find((x) => x.id === g.harness)?.label}
                {!models[g.harness] && <span className="hint"> loading…</span>}
              </div>
              {g.models.map((x) => {
                const entry = formatEntry({ harness: g.harness, model: x.id });
                return (
                  <div key={x.id} className="ce-row">
                    <span className="mono grow" title={x.label}>
                      {entry}
                    </span>
                    <button type="button" className="btn" style={{ padding: "1px 8px" }} disabled={chain.includes(entry)} onClick={() => add(entry)}>
                      {chain.includes(entry) ? "added" : "+ add"}
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
          {HARNESSES.filter((x) => !available.includes(x.id)).length > 0 && (
            <div className="hint">
              Not installed on this runner: {HARNESSES.filter((x) => !available.includes(x.id)).map((x) => x.label).join(", ")}.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
