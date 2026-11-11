// API threads have their own app-server and CODEX_HOME. The shared login daemon is never
// reconfigured. One process per thread lets a rotated key restart that idle thread alone.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BillingSource } from "../../../../shared/credentials";
import type { Billing } from "../../../../shared/transcript";
import { CredentialStore, DATA_DIR, type CredentialSnapshot } from "../../credentials";
import { HARNESS_BINS } from "../detect";
import { connect } from "./daemon";
import { remember, remembered, rememberedThreads } from "./remember";
import { CodexRpc } from "./rpc";
import { childEnv } from "../../childEnv";

export type ApiSource = "openai" | "azure";
export interface PrivateSource { id: string; source: ApiSource; projectPath: string }
interface ProcessRecord { pid: number; birth: string; revision: string; unit?: string }
const inFlight = new Map<string, Promise<CodexRpc>>();
export const sourceProvider = (source: ApiSource) => source === "azure" ? "tether_azure" : "tether_openai";
export const sourceBilling = (source: ApiSource): Billing => source === "azure" ? { kind: "provider", label: "Azure" } : { kind: "apiKey", label: "OpenAI API key" };
const sourceName = (source: BillingSource) => source === "openai" || source === "azure" ? sourceBilling(source).label : "ChatGPT plan";
/** Threads don't cross app-servers. A record that disagrees with the session stops; it never reroutes. */
export function assertThreadSource(thread: PrivateSource | undefined, credential?: CredentialSnapshot) {
  const on = thread?.source ?? "subscription";
  if (credential && on !== credential.source) throw new Error(`This Codex thread is on ${sourceName(on)}, not this session's ${sourceName(credential.source)}. Nothing was sent.`);
}
export const sourceHome = (source: PrivateSource) => join(DATA_DIR, "codex-keys", source.id);
export const sourceSocket = (source: PrivateSource) => join(sourceHome(source), "s");
const recordFile = (source: PrivateSource) => join(sourceHome(source), "daemon.json");
const birthOf = (pid: number): string | undefined => {
  try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); return fields[0] === "Z" ? undefined : fields[19]; } catch { return undefined; }
};
function processRecord(source: PrivateSource): ProcessRecord | undefined {
  try { const r = JSON.parse(readFileSync(recordFile(source), "utf8")); return r.pid > 0 && birthOf(r.pid) === r.birth ? r : undefined; } catch { return undefined; }
}

/** Provider config contains no secret. Never use the built-in openai provider's login fallback. */
export function providerConfig(source: ApiSource, endpoint?: string): Record<string, unknown> {
  const provider = sourceProvider(source);
  if (source === "azure" && !endpoint) throw new Error("Set the Azure resource in Settings, Azure.");
  return {
    model_provider: provider,
    [`model_providers.${provider}.name`]: source === "azure" ? "Azure" : "OpenAI API key",
    [`model_providers.${provider}.base_url`]: source === "azure" ? endpoint : "https://api.openai.com/v1",
    [`model_providers.${provider}.env_key`]: "TETHER_CODEX_API_KEY",
    [`model_providers.${provider}.wire_api`]: "responses",
    [`model_providers.${provider}.requires_openai_auth`]: false,
    [`model_providers.${provider}.supports_websockets`]: false,
    [`model_providers.${provider}.request_max_retries`]: 0,
    [`model_providers.${provider}.stream_max_retries`]: 0,
  };
}

/** A restricted inherited environment: no alternate provider key, proxy credential, or trace sink. */
export function privateEnvironment(home: string, key?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = childEnv();
  for (const k of Object.keys(env)) if (/^(CODEX_|OPENAI_|AZURE_|ANTHROPIC_|CLAUDE_|RUST_|OTEL_|TETHER_GATEWAY_)/.test(k) || k === "TETHER_TOKEN") delete env[k];
  env.CODEX_HOME = home;
  if (key) env.TETHER_CODEX_API_KEY = key;
  else delete env.TETHER_CODEX_API_KEY;
  return env;
}

/** No stale driver can send after its key changes, including a change during settings RPCs. */
export function assertCredentialCurrent(credential?: CredentialSnapshot) {
  if (credential && CredentialStore.current && CredentialStore.current.snapshot(credential.source, credential.deployment)?.revision !== credential.revision) throw new Error(`${sourceName(credential.source)} changed. Send again. Nothing was sent.`);
}

export const sourceCredentialRevision = (source: PrivateSource) => processRecord(source)?.revision;

/** The RPC result must be complete before retirement treats a private thread as idle. */
export function privateThreadBusy(nativeId: string, thread: any, terminals: any): boolean {
  if (thread?.thread?.id !== nativeId || typeof thread?.thread?.status?.type !== "string" || !Array.isArray(terminals?.data)) {
    throw new Error("Couldn't confirm this session's private Codex process is idle; it was left running.");
  }
  return thread.thread.status.type !== "idle" || terminals.data.length > 0;
}


async function stopPrivate(source: PrivateSource, record: ProcessRecord) {
  // Record and Linux start time identify only the private process Tether itself started.
  if (birthOf(record.pid) !== record.birth) return;
  if (record.unit) {
    const p = Bun.spawn(["systemctl", "--user", "stop", record.unit], { env: childEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    if (await p.exited !== 0) throw new Error("Couldn't stop this session's private Codex process. Nothing was sent.");
  } else {
    try { process.kill(-record.pid, "SIGTERM"); } catch {}
  }
  for (let i = 0; i < 100 && birthOf(record.pid) === record.birth; i++) await Bun.sleep(50);
  if (birthOf(record.pid) === record.birth) throw new Error("This session's private Codex process hasn't stopped. Nothing was sent.");
}

async function ensurePrivate(source: PrivateSource, credential?: CredentialSnapshot, nativeId?: string): Promise<CodexRpc> {
  const socket = sourceSocket(source);
  if (Buffer.byteLength(socket) > 103) throw new Error("The runner data directory is too long for a private Codex socket. Choose a shorter TETHER_DATA_DIR. Nothing was sent.");
  const old = processRecord(source);
  let rpc: CodexRpc | undefined;
  try { rpc = await CodexRpc.connect("tether-key-session", socket); } catch {}
  // Discovery can read a still-running daemon, even after its key was unset. It never starts a turn.
  if (rpc && (!credential || old?.revision === credential.revision)) return rpc;
  if (rpc) {
    try {
      if (nativeId) {
        const r: any = await rpc.call("thread/read", { threadId: nativeId, includeTurns: false });
        const running: any = await rpc.call("thread/backgroundTerminals/list", { threadId: nativeId, limit: 1 });
        if (r?.thread?.status?.type === "active" || running?.data?.length) throw new Error("Codex is still working with the previous key. Wait for it to finish. Nothing was sent.");
      }
    } finally { rpc.close(); }
    if (!old) throw new Error("Can't identify this session's private Codex process. Nothing was sent.");
    await stopPrivate(source, old);
  } else if (old) {
    // A live process with an unavailable socket is never replaced or silently bypassed.
    throw new Error("This session's private Codex process isn't reachable. Nothing was sent.");
  }
  const use = credential ?? CredentialStore.current?.snapshot(source.source);
  const home = sourceHome(source);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  if (!use?.key) throw new Error(`Set ${sourceName(source.source)} in ${source.source === "azure" ? "Settings, Azure" : "Credentials"} before continuing. Nothing was sent.`);
  const endpoint = source.source === "openai" ? "https://api.openai.com/v1" : use.endpoint;
  if (!endpoint) throw new Error("Set the Azure resource in Settings, Azure. Nothing was sent.");
  try { unlinkSync(socket); } catch {}
  const argv = [process.execPath, join(import.meta.dir, "privateHost.ts"), home, source.projectPath, source.source, endpoint, source.id, HARNESS_BINS.codex];
  const unit = process.env.INVOCATION_ID && Bun.which("systemd-run") ? `tether-key-${source.id}.scope` : undefined;
  const command = unit ? ["systemd-run", "--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, ...argv] : argv;
  const p = spawn(command[0]!, command.slice(1), { env: { ...privateEnvironment(home), TETHER_GATEWAY_KEY: use.key, ...(use.pricing ? { TETHER_GATEWAY_PRICING: JSON.stringify(use.pricing) } : {}), ...(use.deployment ? { TETHER_GATEWAY_DEPLOYMENT: use.deployment } : {}) }, detached: true, stdio: "ignore", cwd: source.projectPath });
  let failed = false;
  p.on("error", () => { failed = true; });
  p.unref();
  if (!p.pid) throw new Error("Couldn't start this session's private Codex process.");
  const record: ProcessRecord = { pid: p.pid, birth: birthOf(p.pid) ?? "", revision: use?.revision ?? "unavailable", ...(unit ? { unit } : {}) };
  writeFileSync(recordFile(source), JSON.stringify(record), { mode: 0o600 });
  for (let i = 0; i < 100 && !failed; i++) {
    try {
      const result = await CodexRpc.connect("tether-key-session", socket);
      chmodSync(socket, 0o600);
      return result;
    } catch { await Bun.sleep(100); }
  }
  await stopPrivate(source, record);
  throw new Error("Couldn't connect to this session's private Codex process. Nothing was sent.");
}
export function confirmedProxy(source: PrivateSource): { endpoint?: string; proxyBase?: string } {
  try { return JSON.parse(readFileSync(join(sourceHome(source), "source.json"), "utf8")); } catch { return {}; }
}
/** Discovery only joins a socket that exists; it never starts a process. */
export const existingPrivateConnection = (source: PrivateSource) => CodexRpc.connect("tether-key-history", sourceSocket(source));
export function privateConnection(source: PrivateSource, credential?: CredentialSnapshot, nativeId?: string): Promise<CodexRpc> {
  const key = source.id;
  const had = inFlight.get(key);
  if (had) return had.then(() => privateConnection(source, credential, nativeId));
  const p = ensurePrivate(source, credential, nativeId);
  inFlight.set(key, p);
  return p.finally(() => { if (inFlight.get(key) === p) inFlight.delete(key); });
}
export async function stopPrivateSource(source: PrivateSource) { const record = processRecord(source); if (record) await stopPrivate(source, record); }

/**
 * Retires an idle API session's private host. This only connects to an existing socket and only
 * stops the process recorded for this exact private source. A live turn or terminal keeps it up.
 */
export async function retirePrivateSource(nativeId: string): Promise<void> {
  const source = remembered(nativeId)?.source;
  if (!source) return; // subscription daemon, or no known private source
  if (!/^[a-f0-9]{32}$/.test(source.id) || (source.source !== "openai" && source.source !== "azure")) return;
  if (inFlight.has(source.id)) return; // a connect/start is still being established
  const record = processRecord(source);
  if (!record) return;

  let rpc: CodexRpc;
  try { rpc = await existingPrivateConnection(source); }
  catch { throw new Error("This session's private Codex process isn't reachable; it was left running."); }
  try {
    let thread: any;
    let terminals: any;
    try {
      [thread, terminals] = await Promise.all([
        rpc.call("thread/read", { threadId: nativeId, includeTurns: false }),
        rpc.call("thread/backgroundTerminals/list", { threadId: nativeId, limit: 1 }),
      ]);
    } catch {
      throw new Error("Couldn't confirm this session's private Codex process is idle; it was left running.");
    }
    if (privateThreadBusy(nativeId, thread, terminals)) return;
    // Child threads share this host. A parent can be idle while a child still works; confirm the
    // whole descendant tree independently of notifications already delivered to Tether.
    const parents = [nativeId];
    const seen = new Set(parents);
    while (parents.length) {
      if (seen.size > 200) return;
      const children: any = await rpc.call("thread/list", { parentThreadId: parents.shift(), sourceKinds: ["subAgent", "subAgentThreadSpawn", "subAgentOther"], limit: 100 });
      if (!Array.isArray(children?.data) || children.nextCursor) return;
      for (const child of children.data) {
        if (!child?.id || (child.status?.type !== "idle" && child.status?.type !== "notLoaded")) return;
        const running: any = await rpc.call("thread/backgroundTerminals/list", { threadId: child.id, limit: 1 });
        if (!Array.isArray(running?.data) || running.data.length || running.nextCursor) return;
        if (!seen.has(child.id)) { seen.add(child.id); parents.push(child.id); }
      }
    }
  } finally { rpc.close(); }

  // Re-read the durable ownership record after the RPCs so a replaced process is never stopped.
  const current = processRecord(source);
  if (!current || current.pid !== record.pid || current.birth !== record.birth || current.unit !== record.unit) return;
  await stopPrivate(source, current);
}

export async function newConnection(projectPath: string, credential?: CredentialSnapshot): Promise<{ rpc: CodexRpc; source?: PrivateSource }> {
  if (!credential || credential.source === "subscription") return { rpc: await connect() };
  if (credential.source !== "openai" && credential.source !== "azure") throw new Error("Unsupported Codex credential source.");
  const source: PrivateSource = { id: randomUUID().replaceAll("-", ""), source: credential.source, projectPath };
  return { rpc: await privateConnection(source, credential), source };
}
export async function threadConnection(nativeId: string, credential?: CredentialSnapshot, observe = false): Promise<CodexRpc> {
  const source = remembered(nativeId)?.source;
  if (observe) return source ? existingPrivateConnection(source) : connect();
  assertThreadSource(source, credential);
  return source ? privateConnection(source, credential, nativeId) : connect();
}
export function observedCredential(nativeId: string): CredentialSnapshot {
  const source = remembered(nativeId)?.source;
  return source ? { source: source.source, revision: sourceCredentialRevision(source) ?? "unknown", endpoint: confirmedProxy(source).endpoint } : { source: "subscription", revision: "subscription" };
}
export async function threadCall<T = any>(nativeId: string, method: string, params: unknown, timeout?: number): Promise<T> {
  const source = remembered(nativeId)?.source;
  if (!source) return (await import("./daemon")).call<T>(method, params, timeout);
  const rpc = await existingPrivateConnection(source);
  try { return await rpc.call<T>(method, params, timeout); } finally { rpc.close(); }
}
export function privateThreads(): [string, PrivateSource][] {
  return Object.entries(rememberedThreads()).flatMap(([id, r]) => r.source && !r.parentSource ? [[id, r.source] as [string, PrivateSource]] : []);
}
export function rememberSource(nativeId: string, source: PrivateSource, child = false) {
  remember(nativeId, { source, ...(child ? { parentSource: true } : {}) });
}
