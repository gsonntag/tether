import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { dollars } from "../../../shared/costs";
import { planLines } from "../../../shared/labels";
import { totalTokens, type UsageReport, type UsageTotals } from "../../../shared/usage";
import { rpc } from "../connection";
import { useStore } from "../store";
import { bars, browserTimeZone, dayLabel, fmtPart, fmtPrice, fmtTokens, modelName, scanLine, SERIES, type Metric } from "../usage";
import { useNow } from "./useNow";

const POLL_MS = 1500;
const RANGES = [7, 30];

/** Settings → Usage: one runner's tokens and API-price estimates, from its harnesses' own logs. */
export function UsageSettings({ runnerId }: { runnerId: string }) {
  const link = useStore((s) => s.link);
  const now = useNow();
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<UsageReport>();
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const load = useCallback(async (refresh = false) => {
    try {
      const r = await rpc(runnerId, "usage", { days, timeZone: browserTimeZone(), ...(refresh ? { refresh } : {}) });
      if (alive.current) (setReport(r), setError(undefined));
    } catch (e) {
      const msg = (e as Error)?.message ?? "";
      if (alive.current) setError(/doesn't know/.test(msg) ? "This runner can't show usage. Update and restart it." : msg || "Couldn't load usage.");
    }
  }, [runnerId, days]);

  useEffect(() => {
    if (link === "open") void load();
  }, [link, load]);
  // While the runner reads its logs, follow along.
  const running = !!report?.scan.running;
  useEffect(() => {
    if (!running || link !== "open") return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [running, link, load]);

  return (
    <div className="t-usage">
      <div className="t-usage-bar">
        <div className="t-usage-range" role="group" aria-label="Range">
          {RANGES.map((d) => <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>{d} days</button>)}
        </div>
        <span className="t-credential-status" aria-live="polite">{report ? scanLine(report.scan, now) : error ? "" : "Loading…"}</span>
        <Button label="Refresh" variant="secondary" size="sm" isDisabled={link !== "open" || running} onClick={() => void load(true)} />
      </div>
      {error && <div className="t-inline-status error" role="alert">{error}</div>}
      {report && <Report report={report} now={now} />}
    </div>
  );
}

function Report({ report, now }: { report: UsageReport; now: number }) {
  const t = report.total;
  const plans = report.plans.map((p) => ({ ...p, lines: planLines(p.plan, now) })).filter((p) => p.lines.length);
  return <>
    {plans.length > 0 && (
      <section className="t-usage-plans" aria-label="Plan limits">
        {plans.map((p) => <div key={p.harness}><strong>{p.label}</strong>{p.lines.map((l) => <span key={l}>{l}</span>)}</div>)}
      </section>
    )}
    <dl className="t-usage-summary">
      <Tile label="Tokens" value={fmtTokens(totalTokens(t))} note={`${t.requests.toLocaleString()} requests`} />
      <Tile label="At API prices (est.)" value={fmtPrice(t)} note={t.unpriced ? `${t.unpriced.toLocaleString()} requests have no published price` : "what it would cost on the API"} />
      <Tile label="Plan usage at API prices" value={dollars(t.plan)} note="estimate; plans don't bill per token" />
      <Tile label="API keys at API prices" value={dollars(t.key)} note="estimate" />
      {report.ledger && <Tile label="Billed to API keys" value={dollars(report.ledger.usd)} note={`Tether's ledger, ${report.ledger.sessions} session${report.ledger.sessions === 1 ? "" : "s"}' whole totals${report.ledger.complete ? "" : "; some unknown"}`} />}
      {t.unknown > 0 && <Tile label="Source unknown" value={dollars(t.unknown)} note="at API prices; no record of what it drew from" />}
      <Tile label="Cache savings (est.)" value={dollars(t.savings)} note="cache reads at the full input price, less their cost" />
    </dl>
    <Daily report={report} />
    <Table title="By model" rows={report.byModel.map((m) => ({ key: `${m.harness}:${m.model}`, name: modelName(m.harness, m.model), title: m.model, t: m }))} />
    <Table title="By project" rows={report.byProject.map((p) => ({ key: p.path ?? p.name, name: p.name, title: p.path ?? (p.hidden ? "Folders TETHER_HIDE_PROJECTS hides, and the Home agent's" : undefined), t: p }))} />
    <p className="t-usage-note">
      Read from Claude Code's and Codex's own session logs on this runner, every session on it. Dollars are estimates at published API prices (Anthropic's and OpenAI's standard rates), not invoices; a model with no published price shows its tokens only. A source is a session's latest start as Tether recorded it, or Codex's own record. Days are in {report.timeZone}.
    </p>
  </>;
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd><dd className="t-usage-tile-note">{note}</dd></div>;
}

const H = 160;

function Daily({ report }: { report: UsageReport }) {
  const [metric, setMetric] = useState<Metric>("tokens");
  const { max, bars: list } = bars(report.byDay, metric, H);
  const n = list.length;
  const step = 100 / n;
  const fmt = (v: number) => (metric === "usd" ? dollars(v) : fmtTokens(v));
  const labelEvery = n > 14 ? 7 : 1;
  return (
    <section className="t-usage-section" aria-label="By day">
      <div className="t-usage-head">
        <Heading level={3}>By day</Heading>
        <div className="t-usage-range" role="group" aria-label="Measure">
          <button type="button" aria-pressed={metric === "tokens"} onClick={() => setMetric("tokens")}>Tokens</button>
          <button type="button" aria-pressed={metric === "usd"} onClick={() => setMetric("usd")}>API price</button>
        </div>
      </div>
      {metric === "tokens" && (
        <ul className="t-usage-legend" aria-hidden="true">
          {SERIES.map((s) => <li key={s.key}><i className={`t-usage-${s.key}`} />{s.label}</li>)}
        </ul>
      )}
      <div className="t-usage-chart">
        <span className="t-usage-axis-top">{fmt(max)}</span>
        <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" role="img" aria-label={`${metric === "usd" ? "API price" : "Tokens"} per day, ${dayLabel(report.from)} to ${dayLabel(report.to)}; the table below has the numbers.`}>
          <line x1="0" x2="100" y1={H - 0.5} y2={H - 0.5} className="t-usage-baseline" vectorEffect="non-scaling-stroke" />
          {list.map((b, i) => (
            <g key={b.day}>
              <title>{`${dayLabel(b.day, { weekday: "short", month: "short", day: "numeric" })}: ${fmt(b.total)}`}</title>
              <rect x={i * step} y={0} width={step} height={H} className="t-usage-hit" />
              {b.segments.map((s) => <rect key={s.key} x={i * step + step * 0.15} width={step * 0.7} y={s.y} height={Math.max(s.h, 0.5)} className={`t-usage-${s.key}`} />)}
            </g>
          ))}
        </svg>
        <div className="t-usage-xlabels" aria-hidden="true">
          {list.map((b, i) => <span key={b.day} style={{ left: `${(i + 0.5) * step}%` }}>{(n - 1 - i) % labelEvery === 0 ? dayLabel(b.day) : ""}</span>)}
        </div>
      </div>
      <details className="t-usage-details">
        <summary>Table</summary>
        <Table rows={[...report.byDay].reverse().filter((d) => d.requests).map((d) => ({ key: d.day, name: dayLabel(d.day, { weekday: "short", month: "short", day: "numeric" }), t: d }))} empty="No usage in this range." />
      </details>
    </section>
  );
}

interface Row { key: string; name: string; title?: string; t: UsageTotals }

function Table({ title, rows, empty = "No usage in this range." }: { title?: string; rows: Row[]; empty?: string }) {
  const table = !rows.length ? <div className="t-inline-status">{empty}</div> : (
    <div className="t-usage-scroll">
      <table className="t-usage-table">
        <thead>
          <tr><th scope="col">{title ? title.replace(/^By /, "").replace(/^./, (c) => c.toUpperCase()) : "Day"}</th><th scope="col">Input</th><th scope="col">Output</th><th scope="col">Cache read</th><th scope="col">Cache write</th><th scope="col">At API prices</th><th scope="col">Plan</th><th scope="col">API keys</th><th scope="col">Unknown</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row" title={r.title}>{r.name}</th>
              <td>{fmtTokens(r.t.input)}</td>
              <td>{fmtTokens(r.t.output)}</td>
              <td>{fmtTokens(r.t.cacheRead)}</td>
              <td>{fmtTokens(r.t.cacheWrite)}</td>
              <td className={r.t.unpriced === r.t.requests ? "t-usage-unpriced" : undefined} title={r.t.unpriced ? `${r.t.unpriced.toLocaleString()} of ${r.t.requests.toLocaleString()} requests have no published price` : undefined}>{fmtPrice(r.t)}</td>
              <td>{fmtPart(r.t.plan, r.t)}</td>
              <td>{fmtPart(r.t.key, r.t)}</td>
              <td>{fmtPart(r.t.unknown, r.t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  if (!title) return table;
  return <section className="t-usage-section" aria-label={title}><Heading level={3}>{title}</Heading>{table}</section>;
}
