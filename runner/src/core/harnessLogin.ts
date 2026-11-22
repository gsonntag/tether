import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { HarnessLoginFlow, HarnessLoginStatus } from "../../../shared/harnessLogin";
import { HARNESS_LABELS, type HarnessId } from "../../../shared/transcript";
import { AcpClient } from "../adapters/acp/client";
import { acpArgv, reader } from "../adapters/antigravity/store";
import { claudeEnv, claudeSubscriptionStatus, clearClaudeLoginStatus } from "../adapters/claude/credentials";
import { call as codexCall, connect as codexConnect } from "../adapters/codex/daemon";
import { HARNESS_BINS } from "../adapters/detect";
import { childEnv } from "../childEnv";
import type { OpRegistry } from "./ops";

const FLOW_MS = 15 * 60_000;
const READ_MS = 10_000;
const SIGN_IN_PAGES: Record<HarnessId, string[]> = {
  claude: ["https://claude.ai/oauth/authorize", "https://claude.com/oauth/authorize"],
  codex: ["https://auth.openai.com/codex/device"],
  antigravity: ["https://accounts.google.com/o/oauth2/auth", "https://accounts.google.com/o/oauth2/v2/auth"],
};

function signInUrl(harness: HarnessId, value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return;
  try {
    const url = new URL(value);
    if (!url.username && !url.password && SIGN_IN_PAGES[harness].includes(url.origin + url.pathname)) return url.href;
  } catch {}
}

function assertHarness(value: HarnessId) {
  if (!Object.hasOwn(HARNESS_LABELS, value)) throw new Error("Unknown harness.");
}

function account(email: unknown, plan: unknown): HarnessLoginStatus {
  return {
    state: "signedIn",
    ...(typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? { email } : {}),
    ...(typeof plan === "string" && /^[\w .+-]{1,60}$/.test(plan) ? { plan } : {}),
  };
}

async function agyCall(method: string) {
  const acp = new AcpClient({ argv: acpArgv(), cwd: homedir() });
  try {
    await acp.call("initialize", { protocolVersion: 1, clientCapabilities: {} }, READ_MS);
    return await acp.call(method, {}, READ_MS);
  } finally {
    await acp.close();
  }
}

async function loginStatus(harness: HarnessId): Promise<HarnessLoginStatus> {
  assertHarness(harness);
  if (!Bun.which(HARNESS_BINS[harness])) return { state: "unavailable" };
  try {
    switch (harness) {
      case "claude": {
        const status = await claudeSubscriptionStatus(HARNESS_BINS.claude);
        if (status?.authMethod === "claude.ai" && status.loggedIn === true) return account(status.email, status.subscriptionType);
        return { state: typeof status?.loggedIn === "boolean" ? "signedOut" : "unknown" };
      }
      case "codex": {
        const { account: current } = await codexCall("account/read", { refreshToken: false }, READ_MS);
        return current?.type === "chatgpt" ? account(current.email, current.planType) : { state: "signedOut" };
      }
      case "antigravity": {
        const result = await agyCall("session/list");
        const info = result?._meta?.antigravity;
        return account(info?.email, info?.tier?.name);
      }
    }
  } catch (e) {
    return { state: harness === "antigravity" && e instanceof Error && e.message === "Authentication required" ? "signedOut" : "unknown" };
  }
}

interface Flow {
  owner: string;
  view: HarnessLoginFlow;
  abort: AbortController;
  sendCode?: (code: string) => void;
}

/** CLI output is private. Only recognized browser URLs and prompt state can become RPC results. */
async function cliLogin(harness: "claude" | "antigravity", flow: Flow) {
  const argv = harness === "claude" ? [HARNESS_BINS.claude, "auth", "login", "--claudeai"] : [...acpArgv(), "--login"];
  const authEnv = harness === "claude" ? claudeEnv() : {};
  const proc = Bun.spawn(argv, {
    cwd: homedir(), env: childEnv({ ...authEnv, BROWSER: "/bin/false", CLAUDECODE: undefined }),
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const abort = () => { proc.kill("SIGKILL"); };
  flow.abort.signal.addEventListener("abort", abort, { once: true });
  flow.sendCode = (code) => { proc.stdin.write(code + "\n"); proc.stdin.flush(); };

  async function read(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    let tail = "";
    for await (const bytes of stream) {
      tail = (tail + decoder.decode(bytes, { stream: true })).slice(-8192);
      if (flow.view.state !== "pending") continue;
      const clean = tail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      // Only use the initial challenge, before any pasted code can appear in output.
      if (!flow.view.url && flow.sendCode) {
        for (const match of clean.matchAll(/https:\/\/[^\s<>"']+(?=\s)/g)) {
          const url = signInUrl(harness, match[0]);
          if (url) { flow.view.url = url; break; }
        }
      }
      if (/paste (?:the authorization )?code(?: here if prompted|, or the full URL)/i.test(clean) && flow.sendCode) flow.view.acceptsCode = true;
    }
  }

  try {
    const [code] = await Promise.all([proc.exited, read(proc.stdout), read(proc.stderr)]);
    return code === 0;
  } finally {
    flow.abort.signal.removeEventListener("abort", abort);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }
}

/** Use the same Codex daemon that owns subscription sessions, so its auth cache updates as well. */
async function codexLogin(flow: Flow) {
  const rpc = await codexConnect("tether-login");
  let loginId: string | undefined;
  let completed = false;
  let early: { id: string; success: boolean } | undefined;
  let finish!: (success: boolean) => void;
  const result = new Promise<boolean>((resolve) => { finish = resolve; });
  const abort = () => finish(false);
  flow.abort.signal.addEventListener("abort", abort, { once: true });
  rpc.onClose(abort);
  rpc.onNotify((method, params) => {
    if (method !== "account/login/completed" || typeof params.loginId !== "string") return;
    if (!loginId) early = { id: params.loginId, success: params.success === true };
    else if (params.loginId === loginId) {
      completed = true;
      finish(params.success === true);
    }
  });
  try {
    if (flow.abort.signal.aborted) return false;
    const response = await rpc.call("account/login/start", { type: "chatgptDeviceCode" }, 30_000);
    if (typeof response?.loginId === "string") loginId = response.loginId;
    const url = signInUrl("codex", response?.verificationUrl);
    const deviceCode = response?.userCode;
    if (!loginId || !url || typeof deviceCode !== "string" || !/^[A-Z0-9-]{4,20}$/.test(deviceCode)) return false;
    if (flow.view.state === "pending") flow.view = { state: "pending", url, deviceCode };
    if (early?.id === loginId) {
      completed = true;
      return early.success;
    }
    return await result;
  } finally {
    if (loginId && !completed) await rpc.call("account/login/cancel", { loginId }, READ_MS).catch(() => {});
    flow.abort.signal.removeEventListener("abort", abort);
    rpc.close();
  }
}

async function logout(harness: HarnessId) {
  switch (harness) {
    case "codex":
      await codexCall("account/logout", {}, READ_MS);
      break;
    case "antigravity":
      await agyCall("logout");
      break;
    case "claude": {
      const proc = Bun.spawn([HARNESS_BINS.claude, "auth", "logout"], {
        cwd: homedir(), env: childEnv(claudeEnv()), stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      const timer = setTimeout(() => proc.kill("SIGKILL"), READ_MS);
      try {
        if (await proc.exited !== 0) throw new Error("Claude sign-out failed.");
      } finally { clearTimeout(timer); }
      break;
    }
  }
}

export function registerHarnessLogin(ops: OpRegistry, changed: (harness: HarnessId) => void) {
  const flows = new Map<string, Flow>();
  const busy = new Set<HarnessId>();
  const active = new Map<HarnessId, string>();
  const get = (id: string, owner?: string) => {
    const flow = flows.get(id);
    if (!flow || flow.owner !== owner) throw new Error("This sign-in has ended. Start again.");
    return flow;
  };
  const stop = (flow: Flow, state: "cancelled" | "expired") => {
    if (flow.view.state !== "pending") return;
    flow.view = { state };
    flow.abort.abort();
    flow.sendCode = undefined;
  };
  const refresh = async (harness: HarnessId) => {
    if (harness === "claude") clearClaudeLoginStatus();
    if (harness === "antigravity") await reader.close();
    changed(harness);
  };
  ops.register("harnessLoginStatus", ({ harness }) => loginStatus(harness));
  ops.register("harnessLoginStart", ({ harness }, owner) => {
    if (!owner) throw new Error("Harness sign-in requires an owner connection.");
    assertHarness(harness);
    if (!Bun.which(HARNESS_BINS[harness])) throw new Error("This harness isn't installed.");
    // A reloaded or evicted page loses its flowId; give the same owner their running flow back.
    const current = active.get(harness);
    const resumable = current ? flows.get(current) : undefined;
    if (current && resumable?.owner === owner && resumable.view.state === "pending") return { flowId: current };
    if (busy.has(harness)) throw new Error("A sign-in or sign-out is already running.");
    const flowId = randomUUID();
    const flow: Flow = { owner, view: { state: "pending" }, abort: new AbortController() };
    busy.add(harness);
    active.set(harness, flowId);
    flows.set(flowId, flow);
    const timer = setTimeout(() => stop(flow, "expired"), FLOW_MS);
    timer.unref();
    void (async () => {
      try {
        const success = await (harness === "codex" ? codexLogin(flow) : cliLogin(harness, flow));
        if (success) await refresh(harness);
        if (flow.view.state === "pending") flow.view = { state: success ? "done" : "failed" };
      } catch {
        if (flow.view.state === "pending") flow.view = { state: "failed" };
      } finally {
        clearTimeout(timer);
        flow.sendCode = undefined;
        busy.delete(harness);
        if (active.get(harness) === flowId) active.delete(harness);
        setTimeout(() => flows.delete(flowId), 60_000).unref();
      }
    })();
    return { flowId };
  });
  ops.register("harnessLoginPoll", ({ flowId }, owner) => get(flowId, owner).view);
  ops.register("harnessLoginCode", ({ flowId, code }, owner) => {
    const flow = get(flowId, owner);
    if (flow.view.state !== "pending" || !flow.view.acceptsCode || !flow.sendCode) throw new Error("This sign-in isn't waiting for a code.");
    if (typeof code !== "string" || !/^[A-Za-z0-9_.~#+=/-]{1,2048}$/.test(code)) throw new Error("Paste the authorization code from the sign-in page.");
    flow.sendCode(code);
    flow.sendCode = undefined;
    flow.view = { state: "pending" };
    return null;
  });
  ops.register("harnessLoginCancel", ({ flowId }, owner) => { stop(get(flowId, owner), "cancelled"); return null; });
  ops.register("harnessLogout", async ({ harness }) => {
    assertHarness(harness);
    if (busy.has(harness)) throw new Error("A sign-in or sign-out is already running.");
    busy.add(harness);
    try {
      await logout(harness);
      await refresh(harness);
      return await loginStatus(harness);
    } catch {
      throw new Error("Couldn't sign out of this harness.");
    } finally {
      busy.delete(harness);
    }
  });
  return () => { for (const flow of flows.values()) stop(flow, "cancelled"); };
}
