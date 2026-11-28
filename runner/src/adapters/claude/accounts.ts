import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAccountSource, type AccountSource } from "../../../../shared/credentials";
import type { AccountIdentity } from "../../../../shared/harnessLogin";
import { Cswap, type CswapAccount, type CswapOptions } from "./cswap";
import { claudeDir } from "./paths";

type ClaudeIdentity = AccountIdentity & { accountId: string; email: string; organization: string };
export const CSWAP_MANAGED = "This account is managed by cswap. Use cswap to sign in again or remove it.";
const SHARED = ["projects", "history.jsonl", "settings.json", "keybindings.json", "CLAUDE.md", "skills", "commands", "agents", "rules"];

export class ClaudeAccounts {
  readonly signingIn = new Set<AccountSource>();

  /** Accounts the owner set up with cswap, when it's installed: the same `account:<id>` sources. */
  readonly cswap?: Cswap;

  constructor(private readonly root: string, opts: { cswap?: Omit<CswapOptions, "stateDir" | "exclude"> & { primary?: () => Promise<string | undefined> } } = {}) {
    if (opts.cswap) {
      const { primary, ...rest } = opts.cswap;
      this.cswap = new Cswap({ ...rest, stateDir: join(root, ".cswap"), exclude: async () => {
        const main = await primary?.().catch(() => undefined);
        return [...this.nativeList().map(({ identity }) => identity.accountId), ...(main ? [main] : [])];
      } });
    }
  }

  /** A cswap account, usable or not; undefined for Tether's own. */
  cswapAccount(source: AccountSource): CswapAccount | undefined {
    return this.cswap?.find(source);
  }

  /** A source that may be a cswap account Tether can't see right now because discovery failed. */
  cswapUncertain(source: AccountSource): boolean {
    return !!this.cswap?.uncertain && !this.cswapAccount(source) && !this.nativeRead(source);
  }

  /** Discovery is cached briefly; callers that list for the owner wait for a current one. */
  async refresh(): Promise<void> {
    await this.cswap?.refresh();
  }
  private dir(source: AccountSource) {
    if (!isAccountSource(source)) throw new Error("Unknown Claude account.");
    return join(this.root, source.slice("account:".length));
  }

  private privateDir(dir: string) {
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    return !!stat?.isDirectory() && !(stat.mode & 0o077) && stat.uid === process.getuid?.();
  }

  create(): AccountSource {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (!this.privateDir(this.root)) throw new Error("Claude accounts need a private directory.");
    const source = `account:${randomUUID()}` as const;
    const dir = this.dir(source);
    mkdirSync(dir, { mode: 0o700 });
    try {
      mkdirSync(claudeDir(), { recursive: true, mode: 0o700 });
      const shared = realpathSync(claudeDir());
      mkdirSync(join(shared, "projects"), { recursive: true, mode: 0o700 });
      for (const name of SHARED) symlinkSync(join(shared, name), join(dir, name));
      return source;
    } catch {
      this.discard(source);
      throw new Error("Couldn't initialize the Claude account folder.");
    }
  }

  configDir(source: AccountSource): string {
    const cswap = this.cswapAccount(source);
    if (cswap) {
      if (!cswap.configDir) throw new Error(cswap.problem ?? "Claude account folder is unavailable.");
      return cswap.configDir;
    }
    const dir = this.dir(source);
    if (!this.privateDir(this.root) || !this.privateDir(dir)) throw new Error("Claude account folder is unavailable.");
    return dir;
  }

  /** The file the terminal launcher checks the account against: Tether's own, never inside a cswap profile. */
  identityFile(source: AccountSource): string {
    return this.cswapAccount(source) ? this.cswap!.identityFile(source) : join(this.configDir(source), ".tether-account.json");
  }

  read(source: AccountSource): ClaudeIdentity | undefined {
    const cswap = this.cswapAccount(source);
    if (cswap) return cswap.configDir ? cswap.identity : undefined;
    return this.nativeRead(source);
  }

  private nativeRead(source: AccountSource): ClaudeIdentity | undefined {
    try {
      const file = join(this.configDir(source), ".tether-account.json");
      if (!lstatSync(file).isFile()) return;
      const { accountId, email, organization, plan } = JSON.parse(readFileSync(file, "utf8"));
      if (typeof email === "string" && typeof organization === "string" && /^[a-f0-9]{64}$/.test(accountId)) {
        return { email, organization, accountId, ...(typeof plan === "string" ? { plan } : {}) };
      }
    } catch {}
  }

  save(source: AccountSource, identity: ClaudeIdentity) {
    writeFileSync(join(this.configDir(source), ".tether-account.json"), JSON.stringify(identity), { mode: 0o600, flag: "wx" });
  }

  /** Usable accounts: Tether's own, then cswap's. */
  list(): { source: AccountSource; identity: ClaudeIdentity }[] {
    const native = this.nativeList();
    return [...native, ...(this.cswap?.accounts() ?? []).flatMap(({ source, identity, configDir }) =>
      configDir && !native.some((n) => n.identity.accountId === identity.accountId) ? [{ source, identity }] : [])];
  }

  private nativeList(): { source: AccountSource; identity: ClaudeIdentity }[] {
    if (!this.privateDir(this.root)) return [];
    return readdirSync(this.root).sort().flatMap((name) => {
      const source = `account:${name}`;
      const identity = isAccountSource(source) ? this.nativeRead(source) : undefined;
      return identity ? [{ source: source as AccountSource, identity }] : [];
    });
  }

  remove(source: AccountSource) {
    if (this.cswapAccount(source)) throw new Error(CSWAP_MANAGED);
    if (!this.read(source)) throw new Error("Unknown Claude account.");
    this.discard(source);
  }

  discard(source: AccountSource) {
    if (this.cswapAccount(source)) return;
    const dir = this.configDir(source);
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  }
}
