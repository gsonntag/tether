// The Home chat shows Tether's reports to the Home agent (runner/src/modules/homeAgent) as one
// quiet line, the full text a click away: the agent needs the whole report, the person doesn't.
// The line is read from the report's own header lines, the same way for live and stored messages
// (a transcript is the harness's, so the text is all a stored report carries). Anything else from
// Tether gets its first line.

import { fromTether } from "./fromTether";

export type HomeReportKind = "turn" | "waiting" | "watch" | "checkIn" | "other";

export interface HomeReport {
  kind: HomeReportKind;
  /** one line, e.g. `Report from “Fix tests” (tether): finished a turn · 2 of 12` */
  summary: string;
  /** a session failed or is waiting for the person */
  attention: boolean;
}

const SUMMARY_MAX = 140;

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

const basename = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/** `“title” (project)`, or the session's id when the report had no details. */
const named = (title: string | undefined, project: string | undefined, id: string) => (title !== undefined ? `“${clip(title || "Untitled", 60)}”${project ? ` (${project})` : ""}` : id);

// `Session <id> ("<title>" in <path>, <Agent>) finished a turn.` (homeAgent describe + turnEnded/needsPerson)
const SESSION_HEAD = /^Session (\S+)(?: \((.*)\))? (finished a turn(?:\.| with an error: (.*))?|is waiting for the person: (.*))$/;
const DESCRIBED = /^"(.*)" in (.*), [^,]+$/;
const COUNT = /\b[Rr]eport (\d+) of (\d+)\b/;
// `- <id> "<title>" (<project>, <Agent>): finished a turn…` (flushWatched)
const WATCH_LINE = /^- (\S+)(?: "(.*)" \((.*), [^,()]+\))?: (waiting for the person|failed|finished a turn)\b/;
const WATCH_HEAD = "Sessions you didn't start";
const CHECKIN_HEAD = /^Check-in finished: (\d+) sessions? asked\./;
const CHECKIN_PART = /^(Archived|Not archived|Not asked) \((\d+)\):/;

function turnReport(lines: string[]): HomeReport | undefined {
  const m = SESSION_HEAD.exec(lines[0]!);
  if (!m) return undefined;
  const [, id, details, , error, waitingFor] = m;
  const d = details !== undefined ? DESCRIBED.exec(details) : null;
  const who = named(d?.[1], d ? basename(d[2]!) : undefined, id!);
  if (waitingFor !== undefined) {
    const what = waitingFor.replace(/\. Only they can answer it[\s\S]*$/, "");
    return { kind: "waiting", summary: clip(`${who} is waiting for you: ${what}`, SUMMARY_MAX), attention: true };
  }
  const count = lines.map((l) => COUNT.exec(l)).find(Boolean);
  const event = error !== undefined ? `failed: ${error.replace(/\.$/, "")}` : "finished a turn";
  return { kind: "turn", summary: clip(`Report from ${who}: ${event}${count ? ` · ${count[1]} of ${count[2]}` : ""}`, SUMMARY_MAX), attention: error !== undefined };
}

function watchReport(lines: string[]): HomeReport | undefined {
  if (!lines[0]!.startsWith(WATCH_HEAD)) return undefined;
  const items = lines.flatMap((l) => {
    const m = WATCH_LINE.exec(l);
    return m ? [{ who: named(m[2], m[3], m[1]!), what: m[4]! }] : [];
  });
  const failed = items.filter((i) => i.what === "failed").length;
  const waiting = items.filter((i) => i.what === "waiting for the person").length;
  const attention = failed + waiting > 0;
  if (items.length === 1) {
    const i = items[0]!;
    const what = i.what === "waiting for the person" ? "is waiting for you" : i.what;
    return { kind: "watch", summary: clip(`${i.who} ${what} (you didn't start it)`, SUMMARY_MAX), attention };
  }
  const n = items.length || "Some";
  const extra = [failed ? `${failed} failed` : "", waiting ? `${waiting} waiting for you` : ""].filter(Boolean).join(", ");
  return { kind: "watch", summary: `${n} sessions you didn't start updated${extra ? ` · ${extra}` : ""}`, attention };
}

function checkInReport(lines: string[]): HomeReport | undefined {
  const head = CHECKIN_HEAD.exec(lines[0]!);
  if (!head) return undefined;
  const counts: Record<string, number> = {};
  for (const l of lines) {
    const m = CHECKIN_PART.exec(l);
    if (m) counts[m[1]!] = Number(m[2]);
  }
  const parts = [`${counts["Archived"] ?? 0} archived`, `${counts["Not archived"] ?? 0} kept`, ...(counts["Not asked"] ? [`${counts["Not asked"]} not asked`] : [])];
  return { kind: "checkIn", summary: `Check-in finished: ${parts.join(", ")}`, attention: false };
}

/**
 * One of Tether's messages to the Home agent as a line: `text` with or without the `[From Tether] `
 * marker. Undefined for an empty one.
 */
export function homeReport(text: string): HomeReport | undefined {
  const body = (fromTether(text) ?? text).trim();
  const lines = body.split("\n").map((l) => l.trim());
  if (!lines[0]) return undefined;
  return turnReport(lines) ?? watchReport(lines) ?? checkInReport(lines) ?? { kind: "other", summary: clip(lines[0], SUMMARY_MAX), attention: false };
}
