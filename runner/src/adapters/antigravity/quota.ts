// Antigravity's rate limits and quota summary (SPEC §5).
//
// Antigravity partitions quota into separate pools: Gemini models (shared unified pool) and
// Other models (Claude and GPT models with separate fixed rate limits). The Language Server
// behind `agy acp` provides a Connect RPC endpoint:
// POST /exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary
//
// Tether discovers the local HTTP port from the ACP server's log and queries the endpoint
// with the CSRF token passed at process startup. Limits are cached in antigravity-windows.json
// across runner restarts.

import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mergePlan, reportedAt } from "../../../../shared/labels";
import type { PlanPool, PlanUsage, PlanWindow } from "../../../../shared/transcript";
import { CONFIG_DIR } from "../../config";
import { agyHome } from "./store";

interface Windows {
  plan?: PlanUsage;
}

let file: string | undefined = process.env.NODE_ENV === "test" ? undefined : join(CONFIG_DIR, "antigravity-windows.json");
let kept: Windows | undefined;

/** Tests: where it's kept (undefined: memory only), starting empty. */
export function windowsIn(path: string | undefined) {
  file = path;
  kept = undefined;
}

function load(): Windows {
  if (kept) return kept;
  kept = {};
  if (file) {
    try {
      kept = { ...kept, ...JSON.parse(readFileSync(file, "utf8")) };
    } catch {}
  }
  return kept!;
}

function save() {
  if (!file || !kept) return;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(kept), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch {}
}

/** The latest report, kept for stored sessions across restarts. */
export function keepPlan(report: PlanUsage) {
  const w = load();
  w.plan = mergePlan(w.plan, reportedAt(report));
  save();
}

export const keptPlan = (): PlanUsage | undefined => load().plan;

/** Normalizes pool IDs to "gemini" and "other" (or sanitized name). */
export function poolIdOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("gemini")) return "gemini";
  if (lower.includes("claude") || lower.includes("gpt") || lower.includes("3p") || lower.includes("other")) return "other";
  return lower.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "default";
}

/**
 * Parses RetrieveUserQuotaSummary Connect RPC response into multi-pool PlanUsage.
 */
export function parseQuotaSummary(raw: any, at = Date.now()): PlanUsage {
  const data = raw?.response ?? raw?.userQuotaSummary ?? raw ?? {};
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const pools: PlanPool[] = [];

  for (const g of groups) {
    const name: string = g?.displayName ?? g?.name ?? "";
    const id = poolIdOf(name || (pools.length === 0 ? "gemini" : "other"));
    const buckets = Array.isArray(g?.buckets) ? g.buckets : Array.isArray(g?.limits) ? g.limits : [];
    let fiveHour: PlanWindow | undefined;
    let week: PlanWindow | undefined;

    for (const b of buckets) {
      const windowType: string = b?.window ?? b?.duration ?? "";
      const remaining: number | undefined = typeof b?.remainingFraction === "number" ? b.remainingFraction : undefined;
      if (remaining === undefined) continue;

      const percent = Math.min(100, Math.max(0, Math.round((1 - remaining) * 100)));
      const exhausted = remaining <= 0 || b?.exhausted === true;
      const resetsAt = typeof b?.resetTime === "string" ? Date.parse(b.resetTime) : typeof b?.resetsAt === "number" ? b.resetsAt : undefined;
      const win: PlanWindow = { percent, ...(Number.isFinite(resetsAt) ? { resetsAt } : {}), ...(exhausted ? { exhausted: true } : {}), at };

      if (windowType === "5h" || windowType === "five_hour") {
        fiveHour = win;
      } else if (windowType === "weekly" || windowType === "seven_day") {
        week = win;
      }
    }

    if (fiveHour || week) {
      pools.push({
        id,
        name: name || (id === "gemini" ? "Gemini Models" : "Claude and GPT models"),
        ...(fiveHour ? { fiveHour } : {}),
        ...(week ? { week } : {}),
      });
    }
  }

  // Root fiveHour/week reflect the primary pool (Gemini) for single-pool callers.
  const primary = pools.find((p) => p.id === "gemini") ?? pools[0];
  return {
    ...(primary?.fiveHour ? { fiveHour: primary.fiveHour } : {}),
    ...(primary?.week ? { week: primary.week } : {}),
    ...(pools.length > 0 ? { pools } : {}),
    complete: true,
  };
}

/** Finds the Language Server HTTP port from the ACP log for a given PID. */
export async function findLanguageServerPort(pid: number, logDir = join(agyHome(), "log"), maxWaitMs = 3000): Promise<number | undefined> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const files = readdirSync(logDir).filter((f) => f.startsWith("acp-server-") && f.endsWith(`-${pid}.log`));
      if (files.length > 0) {
        const content = readFileSync(join(logDir, files[0]!), "utf8");
        const match = content.match(/Language server listening on random port at (\d+) for HTTP$/m);
        if (match?.[1]) return Number(match[1]);
      }
    } catch {}
    await Bun.sleep(100);
  }
  return undefined;
}

/** Fetches quota from the Language Server Connect RPC endpoint. */
export async function fetchQuota(port: number, csrfToken: string): Promise<PlanUsage> {
  const url = `http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`;
  let lastErr: Error | undefined;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-antigravity-csrf-token": csrfToken,
        },
        body: JSON.stringify({}),
      });

      if (res.status === 200) {
        const json = await res.json();
        const plan = parseQuotaSummary(json);
        keepPlan(plan);
        return plan;
      }
      // Status 500 can happen briefly during server startup while auth settles.
      if (res.status === 500 && attempt < 4) {
        await Bun.sleep(250);
        continue;
      }
      throw new Error(`Language server responded with status ${res.status}`);
    } catch (e: any) {
      lastErr = e;
      if (attempt < 4) await Bun.sleep(250);
    }
  }
  throw lastErr ?? new Error("Failed to retrieve quota summary from language server");
}

interface ActiveServer {
  pid: number;
  csrfToken: string;
  port?: number;
}

const activeServers = new Map<number, ActiveServer>();

export function registerLanguageServer(pid: number, csrfToken: string) {
  activeServers.set(pid, { pid, csrfToken });
}

export function unregisterLanguageServer(pid: number) {
  activeServers.delete(pid);
}

/**
 * Refreshes quota from an active Language Server if available; otherwise returns cached quota.
 */
export async function refreshAntigravityQuota(): Promise<PlanUsage | undefined> {
  for (const s of activeServers.values()) {
    try {
      s.port ??= await findLanguageServerPort(s.pid, undefined, 1500);
      if (s.port) {
        return await fetchQuota(s.port, s.csrfToken);
      }
    } catch {}
  }
  return keptPlan();
}
