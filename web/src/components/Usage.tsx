import { useState } from "react";
import { usageProvider, type ProviderUsage, type UsageWindow } from "../shared/protocol";
import { refreshUsage, useStore } from "../store";
import { fmtClock } from "../util";
import { useClickAway } from "./ModelMenu";

const level = (p?: number) => (p === undefined ? "" : p >= 90 ? " crit" : p >= 70 ? " warn" : "");
const short = (l: string) => (l === "Weekly" ? "wk" : l);

function Bar({ w }: { w: UsageWindow }) {
  return (
    <div className="ubar">
      <span className="ul">{w.label}</span>
      <span className={`utrack${level(w.percent)}`}>
        <span style={{ width: `${w.percent ?? 0}%` }} />
      </span>
      <span className="up">{w.percent === undefined ? "–" : `${w.percent}%`}</span>
      <span className="ur">{w.resetsAt ? `resets ${fmtClock(w.resetsAt)}` : ""}</span>
    </div>
  );
}

export function ProviderBlock({ p }: { p: ProviderUsage }) {
  return (
    <div className="uprov">
      <div className="uh">
        <b>{p.label}</b>
        {p.plan && <span className="uplan">{p.plan}</span>}
        {p.limited && <span className="uplan crit">limit reached</span>}
      </div>
      {p.error ? <div className="hint">{p.error}</div> : p.windows.map((w) => <Bar key={w.label} w={w} />)}
    </div>
  );
}

function AllUsage() {
  const usage = useStore((s) => s.usage);
  return (
    <>
      {!usage ? (
        <div className="hint">Loading usage…</div>
      ) : usage.providers.length === 0 ? (
        <div className="hint">No subscription logins found (Claude, or Codex via pi).</div>
      ) : (
        usage.providers.map((p) => <ProviderBlock key={p.provider} p={p} />)
      )}
      <div className="ufoot">
        {usage && <span>Updated {fmtClock(usage.fetchedAt)}</span>}
        <span className="grow" />
        <button className="linkbtn" onClick={() => refreshUsage(true)}>
          Refresh
        </button>
      </div>
    </>
  );
}

/** Header pill: the 5h / weekly usage of the subscription this session runs on. */
export function UsagePill({ harness, model }: { harness?: string; model?: string }) {
  const usage = useStore((s) => s.usage);
  const [open, setOpen] = useState(false);
  const ref = useClickAway(() => setOpen(false));
  const prov = usageProvider(harness, model);
  const p = prov && usage?.providers.find((x) => x.provider === prov);
  if (!p || p.error || !p.windows.length) return null;
  const main = p.windows.filter((w) => w.label === "5h" || w.label === "Weekly");
  const worst = Math.max(...main.map((w) => w.percent ?? 0));
  return (
    <span ref={ref} className={`pill usage${level(worst)}`} style={{ cursor: "pointer" }} onClick={() => setOpen(!open)} title={`${p.label} plan usage`}>
      {main.map((w) => `${short(w.label)} ${w.percent ?? "–"}%`).join(" · ")}
      {open && (
        <div className="pop upop" onClick={(e) => e.stopPropagation()}>
          <AllUsage />
        </div>
      )}
    </span>
  );
}

/** Sidebar: one compact line per subscription; click for details and reset times. */
export function UsagePanel() {
  const usage = useStore((s) => s.usage);
  const [open, setOpen] = useState(false);
  if (!usage?.providers.length) return null;
  return (
    <div className="side-usage">
      <button className="uhead" onClick={() => setOpen(!open)} title="Plan usage: 5-hour and weekly windows">
        {usage.providers.map((p) => {
          const main = p.windows.filter((w) => w.label === "5h" || w.label === "Weekly");
          return (
            <span key={p.provider} className="urow">
              <span className="un">{p.label}</span>
              {p.error ? (
                <span className="hint" style={{ margin: 0 }}>
                  unavailable
                </span>
              ) : (
                main.map((w) => (
                  <span key={w.label} className={`umini${level(w.percent)}`}>
                    <span className={`utrack${level(w.percent)}`}>
                      <span style={{ width: `${w.percent ?? 0}%` }} />
                    </span>
                    {short(w.label)} {w.percent ?? "–"}%
                  </span>
                ))
              )}
            </span>
          );
        })}
      </button>
      {open && (
        <div className="udetail">
          <AllUsage />
        </div>
      )}
    </div>
  );
}
