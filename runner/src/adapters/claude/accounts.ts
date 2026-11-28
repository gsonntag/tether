import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAccountSource, type AccountSource } from "../../../../shared/credentials";
import type { AccountIdentity } from "../../../../shared/harnessLogin";
import { claudeDir } from "./paths";

type ClaudeIdentity = AccountIdentity & { accountId: string; email: string; organization: string; createdAt?: number };
const SHARED = ["projects", "history.jsonl", "settings.json", "keybindings.json", "CLAUDE.md", "skills", "commands", "agents", "rules"];

export class ClaudeAccounts {
  readonly signingIn = new Set<AccountSource>();

  constructor(private readonly root: string) {}

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
    const dir = this.dir(source);
    if (!this.privateDir(this.root) || !this.privateDir(dir)) throw new Error("Claude account folder is unavailable.");
    return dir;
  }

  read(source: AccountSource): ClaudeIdentity | undefined {
    try {
      const file = join(this.configDir(source), ".tether-account.json");
      if (!lstatSync(file).isFile()) return;
      const { accountId, email, organization, plan, createdAt } = JSON.parse(readFileSync(file, "utf8"));
      if (typeof email === "string" && typeof organization === "string" && /^[a-f0-9]{64}$/.test(accountId)) {
        return {
          email,
          organization,
          accountId,
          ...(typeof plan === "string" ? { plan } : {}),
          ...(typeof createdAt === "number" && Number.isFinite(createdAt) ? { createdAt } : {}),
        };
      }
    } catch {}
  }

  save(source: AccountSource, identity: ClaudeIdentity, createdAt = identity.createdAt ?? Date.now()) {
    writeFileSync(join(this.configDir(source), ".tether-account.json"), JSON.stringify({ ...identity, createdAt }), { mode: 0o600, flag: "wx" });
  }

  list(): { source: AccountSource; identity: ClaudeIdentity }[] {
    if (!this.privateDir(this.root)) return [];
    const entries = readdirSync(this.root).flatMap((name) => {
      const source = `account:${name}`;
      if (!isAccountSource(source)) return [];
      const identity = this.read(source);
      if (!identity) return [];
      let order = identity.createdAt;
      if (order === undefined) {
        try { order = lstatSync(join(this.dir(source), ".tether-account.json")).mtimeMs; } catch { order = 0; }
      }
      return [{ name, order, source: source as AccountSource, identity }];
    });
    return entries
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .map(({ source, identity }) => ({ source, identity }));
  }

  remove(source: AccountSource) {
    if (!this.read(source)) throw new Error("Unknown Claude account.");
    this.discard(source);
  }

  discard(source: AccountSource) {
    const dir = this.configDir(source);
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  }
}
