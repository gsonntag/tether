// Claude accounts the owner manages with cswap (claude-swap), offered as `account:<id>` sources.
// Discovery reads only cswap's public CLI (`cswap list --json`). A profile is made and refreshed by
// `cswap run <n> --share-history`, so Tether and the owner's own `cswap run` share one profile, and
// one credential copy, per account. Tether writes nothing into it; Claude itself does.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { AccountSource } from "../../../../shared/credentials";
import { accountIdentity } from "../../accountIdentity";
import { claudeDir } from "./paths";

export type ClaudeIdentity = { accountId: string; email: string; organization: string; plan?: string };

export interface CswapAccount {
  source: AccountSource;
  /** cswap's slot: only for running it now. Slots can be reordered; the source can't. */
  number: number;
  identity: ClaudeIdentity;
  /** The profile Claude runs in, once cswap has prepared it and it shares ~/.claude's history. */
  configDir?: string;
  /** Why it can't be used now, as a hint for the owner. */
  problem?: string;
  alias?: string;
}

export const CSWAP_RELOGIN = "Signed out in cswap. Run `cswap add` after logging in to this account.";
const UNPREPARED = "cswap couldn't prepare this account. Run `cswap run <n> --share-history` to check it.";
const UNSHARED = "This cswap profile's conversations aren't the runner's (<dir>): cswap shares ~/.claude/projects, so sessions couldn't move between accounts.";
const PRIVATE = "Tether's account folder isn't private to this user, so it can't use cswap accounts.";
// Statuses where cswap holds no usable login (`api_key` slots aren't Claude plans; session mode refuses them).
const SIGNED_OUT = new Set(["relogin_required", "no_credentials"]);
const MARK = "TETHER_CSWAP_CONFIG_DIR=";
const LIST_MS = 15_000;
const RUN_MS = 60_000;
const RETRY_MS = 5 * 60_000;

/** A stable source for a cswap account, from its identity (never its slot), shaped like a native one. */
export function cswapSource(email: string, orgUuid: string): AccountSource {
  const h = createHash("sha256").update(`tether-cswap\0${email.toLowerCase()}\0${orgUuid}`).digest("hex");
  return `account:${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function cswapBin(): string | undefined {
  if (process.env.TETHER_CSWAP === "0") return;
  const local = join(homedir(), ".local", "bin", "cswap");
  return process.env.TETHER_CSWAP_BIN || Bun.which("cswap") || (existsSync(local) ? local : undefined);
}

async function run(argv: string[], env: Record<string, string>, ms: number): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(argv, { cwd: homedir(), env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), ms);
  try {
    const out = await new Response(proc.stdout).text();
    return { code: await proc.exited, out: out.slice(0, 1 << 20) };
  } finally { clearTimeout(timer); }
}

function privateDir(dir: string) {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  return !!stat?.isDirectory() && !(stat.mode & 0o077) && stat.uid === process.getuid?.();
}

export interface CswapOptions {
  /** Tether's own private state: a `claude` shim and the identity files the terminal launcher reads. */
  stateDir: string;
  bin?: string;
  claude?: string;
  /** Identities Tether already has: the primary login and its own accounts. */
  exclude?: () => Promise<Iterable<string>> | Iterable<string>;
  ttlMs?: number;
}

export class Cswap {
  private cache?: { at: number; accounts: CswapAccount[]; failed?: boolean };
  private pending?: Promise<CswapAccount[]>;
  /** Prepared profiles by source and slot: a reordered slot is prepared again. */
  private prepared = new Map<AccountSource, { number: number; configDir: string }>();
  /** A profile cswap couldn't prepare isn't tried again by discovery for a while. */
  private failed = new Map<AccountSource, { number: number; at: number }>();

  constructor(private readonly o: CswapOptions) {}

  /** What the last discovery found; starts another when it's old. Never throws. */
  accounts(): CswapAccount[] {
    if (!this.cache || Date.now() - this.cache.at > (this.o.ttlMs ?? 30_000)) void this.refresh();
    return this.cache?.accounts ?? [];
  }

  find(source: AccountSource) {
    return this.accounts().find((a) => a.source === source);
  }

  /**
   * Whether the last discovery failed (cswap timed out, exited non-zero or printed something it
   * can't read): what was known before is kept, and a source not in it is unknown, not gone.
   */
  get uncertain() { return this.cache?.failed === true; }

  /** Discovery, at most one at a time. No cswap is no accounts; a failure keeps the last ones. */
  refresh(force = false): Promise<CswapAccount[]> {
    if (!force && this.cache && Date.now() - this.cache.at <= (this.o.ttlMs ?? 30_000)) return Promise.resolve(this.cache.accounts);
    // A forced one must start after the call: one already running may predate a slot change.
    if (force && this.pending) return this.pending.then(() => this.refresh(true));
    this.pending ??= this.discover().catch(() => undefined).then((found) => {
      this.cache = { at: Date.now(), accounts: found ?? this.cache?.accounts ?? [], ...(found ? {} : { failed: true }) };
      return this.cache.accounts;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private env(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !/^(TETHER_|OPENAI_|AZURE_|CODEX_API_KEY|AWS_)/.test(k) && !/^(ANTHROPIC_|CLAUDE_CODE_)/.test(k) && k !== "CLAUDE_CONFIG_DIR") env[k] = v;
    }
    return env;
  }

  /** undefined: cswap is there but discovery failed this time. */
  private async discover(): Promise<CswapAccount[] | undefined> {
    const bin = this.o.bin ?? cswapBin();
    if (!bin || !existsSync(bin)) return [];
    const { code, out } = await run([bin, "list", "--json"], this.env(), LIST_MS);
    if (code !== 0) return;
    const data = JSON.parse(out);
    if (data?.schemaVersion !== 1 || !Array.isArray(data.accounts)) return;
    const exclude = new Set(await this.o.exclude?.() ?? []);
    const found: CswapAccount[] = [];
    for (const row of data.accounts) {
      // The active account is cswap's default login (~/.claude): `cswap run` would only run plain `claude`.
      if (!row || row.active === true || row.usageStatus === "api_key" || !Number.isSafeInteger(row.number) || row.number < 1) continue;
      const orgUuid = typeof row.organizationUuid === "string" && row.organizationUuid.length <= 128 ? row.organizationUuid : "";
      const { email, organization, accountId } = accountIdentity(row.email, undefined, row.organizationName, orgUuid || undefined);
      if (!email || !accountId || exclude.has(accountId)) continue;
      const source = cswapSource(email, orgUuid);
      if (found.some((a) => a.source === source)) continue;
      const alias = typeof row.alias === "string" && row.alias.length <= 80 && !/[\u0000-\u001f\u007f]/.test(row.alias) ? row.alias : undefined;
      const account: CswapAccount = { source, number: row.number, identity: { accountId, email, organization: organization ?? email }, ...(alias ? { alias } : {}) };
      if (SIGNED_OUT.has(row.usageStatus)) account.problem = CSWAP_RELOGIN;
      else {
        const known = this.prepared.get(source);
        const failed = this.failed.get(source);
        // A profile whose history link went (a `cswap run` without --share-history) is run again: cswap restores it.
        const configDir = known && known.number === row.number && this.usable(known.configDir) && this.shared(known.configDir) ? known.configDir
          : failed && failed.number === row.number && Date.now() - failed.at < RETRY_MS ? undefined
          : await this.profile(bin, row.number).catch(() => undefined);
        if (configDir) this.failed.delete(source);
        else if (!failed || failed.number !== row.number || Date.now() - failed.at >= RETRY_MS) this.failed.set(source, { number: row.number, at: Date.now() });
        if (!configDir) account.problem = UNPREPARED.replace("<n>", String(row.number));
        else if (!this.shared(configDir)) account.problem = UNSHARED.replace("<dir>", join(claudeDir(), "projects"));
        else if (!this.writeIdentity(source, account.identity)) account.problem = PRIVATE;
        else {
          account.configDir = configDir;
          this.prepared.set(source, { number: row.number, configDir });
        }
      }
      found.push(account);
    }
    return found;
  }

  private usable(dir: string) {
    return isAbsolute(dir) && privateDir(dir);
  }

  /** Conversations must be the same files for every account, or a hop couldn't resume. */
  private shared(dir: string) {
    try { return realpathSync(join(dir, "projects")) === realpathSync(join(claudeDir(), "projects")); } catch { return false; }
  }

  /**
   * `cswap run` makes or refreshes the profile, then runs `claude` from PATH in it. A shim first on
   * PATH reports CLAUDE_CONFIG_DIR for one marker argument and runs the real `claude` otherwise
   * (cswap's own `claude auth status` checks).
   */
  private async profile(bin: string, number: number): Promise<string | undefined> {
    // A path: a bare name would find the shim itself first on PATH.
    const named = this.o.claude ?? (process.env.CLAUDE_BIN || "claude");
    const claude = isAbsolute(named) ? named : Bun.which(named, { PATH: process.env.PATH ?? "" });
    if (!claude || !isAbsolute(claude)) return;
    // Every level up from Tether's account root is checked: cswap resolves `claude` through this folder.
    if (!this.privateState()) return;
    const shims = join(this.o.stateDir, "bin");
    mkdirSync(shims, { recursive: true, mode: 0o700 });
    if (!privateDir(shims)) return;
    const shim = join(shims, "claude");
    const tmp = `${shim}.${process.pid}.tmp`;
    writeFileSync(tmp, `#!/bin/sh\nif [ "$1" = "--tether-cswap-config-dir" ]; then printf '${MARK}%s\\n' "\${CLAUDE_CONFIG_DIR-}"; exit 0; fi\nexec "$TETHER_CSWAP_REAL_CLAUDE" "$@"\n`, { mode: 0o700 });
    chmodSync(tmp, 0o700);
    renameSync(tmp, shim);
    const env = this.env();
    env.PATH = `${shims}:${env.PATH ?? ""}`;
    env.TETHER_CSWAP_REAL_CLAUDE = claude;
    const { code, out } = await run([bin, "run", String(number), "--share-history", "--", "--tether-cswap-config-dir"], env, RUN_MS);
    const line = out.split("\n").find((l) => l.startsWith(MARK));
    const dir = line?.slice(MARK.length);
    // Empty: cswap ran it as its default login, which is Tether's primary subscription, not a profile.
    return code === 0 && dir && this.usable(dir) ? dir : undefined;
  }

  /** Before each start: cswap refreshes the profile (stale credentials, sharing). It must still be the same one. */
  async prepare(source: AccountSource, configDir: string): Promise<void> {
    const bin = this.o.bin ?? cswapBin();
    const account = (await this.refresh(true)).find((a) => a.source === source);
    if (!bin || !account?.configDir) throw new Error(`${account?.problem ?? "The cswap account is unavailable."} Nothing was sent.`);
    const dir = await this.profile(bin, account.number).catch(() => undefined);
    if (dir && dir === configDir && this.shared(dir)) {
      this.prepared.set(source, { number: account.number, configDir: dir });
      return;
    }
    this.prepared.delete(source);
    if (this.cache) this.cache.at = 0;
    throw new Error(`cswap couldn't prepare this Claude account. Run \`cswap run ${account.number} --share-history\` to check it, then try again. Nothing was sent.`);
  }

  identityFile(source: AccountSource) {
    return join(this.o.stateDir, `${source.slice("account:".length)}.json`);
  }

  /** Each level is checked before anything is made or written under it. */
  private privateState() {
    const root = dirname(this.o.stateDir);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!privateDir(root)) return false;
    mkdirSync(this.o.stateDir, { recursive: true, mode: 0o700 });
    return privateDir(this.o.stateDir);
  }

  private writeIdentity(source: AccountSource, identity: ClaudeIdentity): boolean {
    if (!this.privateState()) return false;
    const file = this.identityFile(source);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(identity), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  }
}
