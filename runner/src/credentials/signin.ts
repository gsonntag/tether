// Sign-in relays (.claude/credentials/SPEC.md section 4): a harness's own login command, run on the
// runner and relayed to the browser. The CLI runs in a pseudo-terminal (`script`; Claude Code's
// login is a terminal UI) with echo off and a wide screen so its link stays on one line; Tether
// reads the link (and the device code) out of what it prints, and writes the code you paste back
// to it. The CLI writes the login where it always does: the account's own home, mode 600. Nothing
// it prints goes to the app except the link, the device code and a redacted tail for when no link
// could be found.
//
// Logins with no relayable flow (pi's /login, kiro-cli, agy) are "command" flows: the page shows
// what to run on the runner, and a check notices when the login appears.

import type { SignInFlow } from "../../../web/src/shared/accounts";

const FLOW_MS = 15 * 60_000;
const POLL_MS = 3_000;
const MAX_OUTPUT = 64 * 1024;

interface Running {
  flow: SignInFlow;
  proc?: ReturnType<typeof Bun.spawn>;
  timer?: ReturnType<typeof setTimeout>;
  poll?: ReturnType<typeof setInterval>;
  raw: string;
  /** after the flow ends (done, failed, cancelled) */
  onEnd?: (flow: SignInFlow) => void | Promise<void>;
}

const flows = new Map<string, Running>();

const shq = (s: string) => (/^[A-Za-z0-9_\/.:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The CLI under a pseudo-terminal: util-linux `script` on Linux, the BSD one on macOS. */
export function ptyArgv(argv: string[]): string[] {
  const cmd = `stty cols 1000 rows 50 -echo 2>/dev/null; exec ${argv.map(shq).join(" ")}`;
  if (process.platform === "darwin") return ["script", "-q", "/dev/null", "sh", "-c", cmd];
  return ["script", "-q", "-e", "-f", "-c", cmd, "/dev/null"];
}

/** Terminal output as plain text: escape sequences out, carriage returns as line breaks. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** The link to open: an OAuth authorize link (the one that shows a code to paste first), else the first https link. */
export function findUrl(text: string, kind: SignInFlow["kind"]): string | undefined {
  const urls = [...text.matchAll(/https:\/\/[^\s"'<>`]+/g)].map((m) => m[0].replace(/[).,;]+$/, ""));
  if (!urls.length) return undefined;
  if (kind === "paste") {
    const oauth = urls.filter((u) => /oauth\/authorize|\/authorize\?/.test(u));
    return oauth.find((u) => /code(%2F|\/)callback/i.test(u)) ?? oauth[0] ?? urls[0];
  }
  return urls.find((u) => /device/i.test(u)) ?? urls[0];
}

/** A device code: "ABCD-EFGH" style, outside any link. */
export function findDeviceCode(text: string): string | undefined {
  const plain = text.replace(/https:\/\/\S+/g, " ");
  return plain.match(/\b(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/)?.[0] ?? plain.match(/\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/)?.[0];
}

/** The last lines the CLI printed, long token-like runs cut (links come separately). */
export function outputTail(text: string, lines = 12): string {
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-lines)
    .map((l) =>
      l
        .replace(/https:\/\/\S+/g, "<link>")
        .replace(/[A-Za-z0-9_\-.~+/=]{32,}/g, "…")
        .slice(0, 300),
    )
    .join("\n");
}

export interface RelayOpts {
  /** the credential it signs in */
  id: string;
  kind: "paste" | "device";
  argv: string[];
  env: Record<string, string | undefined>;
  cwd?: string;
  /** after the CLI exits 0: is there a login now? */
  check: () => Promise<boolean>;
  onEnd?: (flow: SignInFlow) => void | Promise<void>;
  /** tests: without the pseudo-terminal */
  noPty?: boolean;
}

const view = (r: Running): SignInFlow => {
  const f = { ...r.flow };
  if (!f.url && f.kind !== "command" && r.raw) f.output = outputTail(stripAnsi(r.raw));
  return f;
};

function end(r: Running, change: Partial<SignInFlow>) {
  if (["done", "failed", "cancelled"].includes(r.flow.state)) return;
  r.flow = { ...r.flow, ...change };
  if (r.timer) clearTimeout(r.timer);
  if (r.poll) clearInterval(r.poll);
  try {
    r.proc?.kill();
  } catch {}
  Promise.resolve(r.onEnd?.(view(r))).catch(() => {});
}

/** Starts a relayed sign-in (any earlier one for the same credential is cancelled). Resolves once a link shows, or soon after. */
export async function startRelay(o: RelayOpts, waitMs = 10_000): Promise<SignInFlow> {
  cancelFlow(o.id);
  const proc = Bun.spawn(o.noPty ? o.argv : ptyArgv(o.argv), {
    cwd: o.cwd,
    env: o.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const r: Running = {
    flow: { id: o.id, kind: o.kind, state: "starting", startedAt: Date.now() },
    proc,
    raw: "",
    onEnd: o.onEnd,
  };
  flows.set(o.id, r);
  r.timer = setTimeout(
    () =>
      end(r, {
        state: "failed",
        message: "The sign-in timed out. Start it again.",
      }),
    FLOW_MS,
  );
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const chunk of stream as any) {
      r.raw = (r.raw + dec.decode(chunk, { stream: true })).slice(-MAX_OUTPUT);
      const text = stripAnsi(r.raw);
      const url = findUrl(text, o.kind);
      const code = o.kind === "device" ? findDeviceCode(text) : undefined;
      if (r.flow.state === "starting" && url && (o.kind === "paste" || code))
        r.flow = {
          ...r.flow,
          state: "waiting",
          url,
          ...(code ? { code } : {}),
        };
    }
  };
  void read(proc.stdout as ReadableStream<Uint8Array>).catch(() => {});
  void read(proc.stderr as ReadableStream<Uint8Array>).catch(() => {});
  proc.exited.then(async (exit) => {
    if (["done", "failed", "cancelled"].includes(r.flow.state)) return;
    if (exit === 0 && (await o.check().catch(() => false))) return end(r, { state: "done", message: undefined });
    const tail = outputTail(stripAnsi(r.raw), 4);
    end(r, {
      state: "failed",
      message: tail ? `The sign-in didn't finish:\n${tail}` : `The sign-in ended (code ${exit}) without a login.`,
    });
  });
  const until = Date.now() + waitMs;
  while (Date.now() < until && r.flow.state === "starting") await Bun.sleep(100);
  return view(r);
}

/** A "command" flow: shows what to run; `check` every few seconds notices the login. */
export function startCommand(o: { id: string; command: string; message?: string; check: () => Promise<boolean>; onEnd?: RelayOpts["onEnd"] }): SignInFlow {
  cancelFlow(o.id);
  const r: Running = {
    flow: {
      id: o.id,
      kind: "command",
      state: "waiting",
      command: o.command,
      ...(o.message ? { message: o.message } : {}),
      startedAt: Date.now(),
    },
    raw: "",
    onEnd: o.onEnd,
  };
  flows.set(o.id, r);
  r.timer = setTimeout(
    () =>
      end(r, {
        state: "failed",
        message: "Stopped waiting for the sign-in. Start it again once you've run it.",
      }),
    2 * FLOW_MS,
  );
  let busy = false;
  r.poll = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (await o.check()) end(r, { state: "done", message: undefined });
    } catch {
    } finally {
      busy = false;
    }
  }, POLL_MS);
  return view(r);
}

/** Pastes the code the sign-in page showed into the CLI. */
export async function submitCode(id: string, code: string): Promise<SignInFlow> {
  const r = flows.get(id);
  if (!r || r.flow.state !== "waiting" || !r.proc) throw new Error("That sign-in isn't waiting for a code. Start it again.");
  const c = code.trim();
  if (!c || /[\r\n\x00-\x1f]/.test(c) || c.length > 2048) throw new Error("That doesn't look like a sign-in code.");
  const stdin = r.proc.stdin as any;
  stdin.write(c);
  await stdin.flush?.();
  await Bun.sleep(150);
  stdin.write("\r");
  await stdin.flush?.();
  r.flow = { ...r.flow, state: "verifying" };
  return view(r);
}

/** The flow for a credential, if one ran since the runner started (ended ones stay until the next). */
export function flowFor(id: string): SignInFlow | undefined {
  const r = flows.get(id);
  return r && view(r);
}

export function cancelFlow(id: string): SignInFlow | undefined {
  const r = flows.get(id);
  if (!r) return undefined;
  end(r, { state: "cancelled" });
  flows.delete(id);
  return view(r);
}

/** Tests and shutdown: every flow stopped. */
export function cancelAllFlows() {
  for (const id of [...flows.keys()]) cancelFlow(id);
}
