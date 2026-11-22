import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { dollars } from "../../../shared/costs";
import { planLines } from "../../../shared/labels";
import { combineUsage, totalTokens, type CombinedUsage, type UsageReport, type UsageTotals } from "../../../shared/usage";
import { rpc } from "../connection";
import { useStore } from "../store";
import { bars, browserTimeZone, dayLabel, fmtPart, fmtPrice, fmtTokens, modelName, partial, scanLine, SERIES, unpricedNote, type Metric } from "../usage";
import { useNow } from "./useNow";

const POLL_MS = 1500;
const RANGES = [7, 30];

export interface UsageRunnerRef { id: string; name: string; online: boolean }
/** A runner left out of "All runners", and why. */
interface Missing { name: string; why: string }

const loadError = (msg: string) => (/doesn't know/.test(msg) ? "This runner can't show usage. Update and restart it." : msg || "Couldn't load usage.");

/**
 * Settings → Usage: tokens and API-price estimates from harness logs and live Antigravity turn records, for one runner or,
 * given several (All runners), every reachable one together; offline or failing ones are named and left out.
 */
export function UsageSettings({ runners }: { runners: UsageRunnerRef[] }) {
  const link = useStore((s) => s.link);
  const now = useNow();
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<UsageReport | CombinedUsage>();
  const [missing, setMissing] = useState<Missing[]>([]);
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  const all = runners.length > 1;
  const key = runners.map((r) => `${r.id}:${r.online ? 1 : 0}:${r.name}`).join("|");

  const load = useCallback(async (refresh = false) => {
    const args = { days, timeZone: browserTimeZone(), ...(refresh ? { refresh } : {}) };
    if (!all) {
      try {
        const r = await rpc(runners[0]!.id, "usage", args);
        if (alive.current) (setReport(r), setError(undefined));
      } catch (e) {
        if (alive.current) setError(loadError((e as Error)?.message ?? ""));
      }
      return;
    }
    const online = runners.filter((r) => r.online);
    const got = await Promise.allSettled(online.map((r) => rpc(r.id, "usage", args)));
    if (!alive.current) return;
    const parts: { id: string; name: string; report: UsageReport }[] = [];
    const lost: Missing[] = runners.filter((r) => !r.online).map((r) => ({ name: r.name, why: "offline" }));
    got.forEach((g, i) => {
      const r = online[i]!;
      if (g.status === "fulfilled") parts.push({ id: r.id, name: r.name, report: g.value });
      else lost.push({ name: r.name, why: loadError((g.reason as Error)?.message ?? "") });
    });
    setMissing(lost);
    if (parts.length) (setReport(combineUsage(parts)), setError(undefined));
    else setError(online.length ? "Couldn't load usage from any runner." : "Every runner is offline.");
  }, [key, days, all]);

  useEffect(() => {
    if (link === "open") void load();
  }, [link, load]);
  // While a runner reads its logs, follow along.
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
      {all && missing.length > 0 && <div className="t-inline-status" role="status">Not included: {missing.map((m) => `${m.name} (${m.why})`).join(", ")}.</div>}
      {report && <Report report={report} now={now} all={all} />}
    </div>
  );
}

function Report({ report, now, all }: { report: UsageReport | CombinedUsage; now: number; all: boolean }) {
  const t = report.total;
  const src = t.sources;
  const providers = src.provider.requests > 0;
  // Logs that couldn't be read: every dollar figure from them is a lower bound.
  const lost = report.scan.errors > 0;
  const plans = report.plans.map((p) => ({ ...p, lines: planLines(p.plan, now) })).filter((p) => p.lines.length);
  return <>
    {plans.length > 0 && (
      <section className="t-usage-plans" aria-label="Plan limits">
        {plans.map((p) => <div key={p.harness}><strong>{p.label}</strong>{p.lines.map((l) => <span key={l}>{l}</span>)}</div>)}
      </section>
    )}
    <dl className="t-usage-summary">
      <Tile label="Tokens" value={fmtTokens(totalTokens(t))} note={`${t.requests.toLocaleString()} requests`} />
      <Tile label="At API prices (est.)" {...partial(lost, fmtPrice(t), t.unpriced ? `${t.unpriced.toLocaleString()} requests have no published price` : "what it would cost on the API")} />
      <Tile label="Plan usage at API prices" {...partial(lost, fmtPart(src.plan), unpricedNote(src.plan, "estimate; plans don't bill per token"))} />
      <Tile label="API keys at API prices" {...partial(lost, fmtPart(src.key), unpricedNote(src.key, "estimate"))} />
      {report.ledger && <Tile label="Billed to API keys" value={`${dollars(report.ledger.usd)}${report.ledger.complete ? "" : "+"}`} note={`Tether's ledger, ${report.ledger.sessions} session${report.ledger.sessions === 1 ? "" : "s"}' whole totals${report.ledger.complete ? "" : "; part isn't known"}`} />}
      {src.provider.requests > 0 && <Tile label="Providers" value={`${src.provider.requests.toLocaleString()} requests`} note="Bedrock, Vertex, Azure and the like set their own prices: none here" />}
      {src.unknown.requests > 0 && <Tile label="Source unknown" {...partial(lost, fmtPart(src.unknown), unpricedNote(src.unknown, "at API prices; before Tether's record of the session's latest start, or none"))} />}
      <Tile label="Cache savings (est.)" {...partial(lost, dollars(t.savings), "cache reads at the full input price, less their cost")} />
    </dl>
    <Daily report={report} />
    {all && "byRunner" in report && <Table title="By runner" providers={providers} rows={report.byRunner.map((r) => ({ key: r.id, name: r.name, t: r }))} empty="No runner answered." />}
    <Table title="By model" providers={providers} rows={report.byModel.map((m) => ({ key: `${m.harness}:${m.model}`, name: modelName(m.harness, m.model), title: m.model, t: m }))} />
    <Table title="By project" providers={providers} rows={report.byProject.map((p) => ({ key: p.path ?? p.name, name: p.name, title: p.path ?? (p.hidden ? "Folders TETHER_HIDE_PROJECTS hides" : undefined), t: p }))} />
    <p className="t-usage-note">
      Antigravity totals cover prompts sent through Tether that return token counts, starting when recording was enabled on each runner. Standalone CLI and terminal turns are excluded. Thought tokens count as output. Antigravity tokens have no API price estimate here.
    </p>
    <p className="t-usage-note">
      Read from Claude Code's and Codex's own session logs {all ? "on each runner shown, every session on them" : "on this runner, every session on it"}. Dollars are estimates at published API prices (Anthropic's and OpenAI's standard rates), not invoices; a model with no published price shows its tokens only, and a "+" marks a sum that leaves some out. Hosted tool fees (web search) aren't counted. Claude's source is as of Tether's last start of the session (before it, unknown); Codex's is from its own logs. Days are in {report.timeZone}.
    </p>
  </>;
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd><dd className="t-usage-tile-note">{note}</dd></div>;
}

const H = 160;

function Daily({ report }: { report: UsageReport }) {
  const [metric, setMetric] = useState<Metric>("tokens");
  const [table, setTable] = useState(false);
  const tableId = useId();
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
        {metric === "usd" && (
          <div className="t-usage-marks" aria-hidden="true">
            {list.filter((b) => b.unpriced).map((b) => <span key={b.day} style={{ left: `${(list.indexOf(b) + 0.5) * step}%`, top: `${b.top}px` }}>+</span>)}
          </div>
        )}
        <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" role="img" aria-label={`${metric === "usd" ? "API price" : "Tokens"} per day, ${dayLabel(report.from)} to ${dayLabel(report.to)}; the table below has the numbers.`}>
          <line x1="0" x2="100" y1={H - 0.5} y2={H - 0.5} className="t-usage-baseline" vectorEffect="non-scaling-stroke" />
          {list.map((b, i) => (
            <g key={b.day}>
              <title>{`${dayLabel(b.day, { weekday: "short", month: "short", day: "numeric" })}: ${fmt(b.total)}${metric === "usd" && b.unpriced ? `+ (${b.unpriced} requests with no price)` : ""}`}</title>
              <rect x={i * step} y={0} width={step} height={H} className="t-usage-hit" />
              {b.segments.map((s) => <rect key={s.key} x={i * step + step * 0.15} width={step * 0.7} y={s.y} height={Math.max(s.h, 0.5)} className={`t-usage-${s.key}`} />)}
            </g>
          ))}
        </svg>
        <div className="t-usage-xlabels" aria-hidden="true">
          {list.map((b, i) => <span key={b.day} style={{ left: `${(i + 0.5) * step}%` }}>{(n - 1 - i) % labelEvery === 0 ? dayLabel(b.day) : ""}</span>)}
        </div>
      </div>
      {metric === "usd" && list.some((b) => b.unpriced) && <div className="t-usage-note">A + marks a day with requests that have no published price: its bar leaves them out.</div>}
      <button type="button" className="t-usage-toggle" aria-expanded={table} aria-controls={tableId} onClick={() => setTable(!table)}>{table ? "Hide the numbers" : "Show the numbers"}</button>
      {table && <div id={tableId}><Table providers={report.total.sources.provider.requests > 0} rows={[...report.byDay].reverse().filter((d) => d.requests).map((d) => ({ key: d.day, name: dayLabel(d.day, { weekday: "short", month: "short", day: "numeric" }), t: d }))} empty="No usage in this range." /></div>}
    </section>
  );
}

interface Row { key: string; name: string; title?: string; t: UsageTotals }

function Table({ title, rows, providers, empty = "No usage in this range." }: { title?: string; rows: Row[]; providers: boolean; empty?: string }) {
  const table = !rows.length ? <div className="t-inline-status">{empty}</div> : (
    <div className="t-usage-scroll">
      <table className="t-usage-table">
        <thead>
          <tr><th scope="col">{title ? title.replace(/^By /, "").replace(/^./, (c) => c.toUpperCase()) : "Day"}</th><th scope="col">Input</th><th scope="col">Output</th><th scope="col">Cache read</th><th scope="col">Cache write</th><th scope="col">At API prices</th><th scope="col">Plan</th><th scope="col">API keys</th>{providers && <th scope="col">Providers</th>}<th scope="col">Unknown</th></tr>
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
              <td>{fmtPart(r.t.sources.plan)}</td>
              <td>{fmtPart(r.t.sources.key)}</td>
              {providers && <td>{fmtPart(r.t.sources.provider)}</td>}
              <td>{fmtPart(r.t.sources.unknown)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  if (!title) return table;
  return <section className="t-usage-section" aria-label={title}><Heading level={3}>{title}</Heading>{table}</section>;
}
