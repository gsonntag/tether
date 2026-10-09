import { HARNESSES, type HarnessId } from "./shared/protocol";

export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function tildify(path: string): string {
  return path.replace(/^\/home\/[^/]+(?=\/|$)/, "~").replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

export function harnessLabel(h: HarnessId) {
  return HARNESSES.find((x) => x.id === h)?.label ?? h;
}

export const badge = (h: HarnessId) => HARNESSES.find((x) => x.id === h)?.badge ?? h;

export function fmtClock(ms: number) {
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  return d.toLocaleString(undefined, sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
