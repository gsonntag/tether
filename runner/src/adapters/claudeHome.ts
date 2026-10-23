// Claude Code sessions on an account home (a credential whose plugin keeps its own CLAUDE_CONFIG_DIR,
// credentials/registry.ts homeFor): their transcripts are under <home>/projects, not ~/.claude. The
// live process gets that home in its env; the SDK's history calls in the runner (getSessionMessages,
// listSessions, forkSession) read $CLAUDE_CONFIG_DIR of the runner itself, which must stay the
// machine's, so they get a session store that reads and writes the account home's files instead.
// Sessions on the machine's own login are untouched (no store: the SDK's own files, as before).

import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { claudeHome } from "../context/paths";
import { config } from "../config";
import { sessionCredential } from "../credentials/registry";

/** A session store over one Claude home's own files (<home>/projects/<projectKey>/<sessionId>.jsonl). */
export function homeSessionStore(home: string): SessionStore {
  const projects = join(home, "projects");
  const fileOf = (k: SessionKey) => (k.subpath ? join(projects, k.projectKey, k.sessionId, `${k.subpath}.jsonl`) : join(projects, k.projectKey, `${k.sessionId}.jsonl`));
  const safe = (k: SessionKey) => ![k.projectKey, k.sessionId, k.subpath ?? ""].some((s) => s.split("/").includes(".."));
  return {
    async append(key, entries) {
      if (!safe(key) || !entries.length) return;
      const f = fileOf(key);
      mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
      appendFileSync(f, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
    },
    async load(key) {
      if (!safe(key)) return null;
      let text: string;
      try {
        text = readFileSync(fileOf(key), "utf8");
      } catch {
        return null;
      }
      const out: SessionStoreEntry[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {}
      }
      return out;
    },
    async listSessions(projectKey) {
      const dir = join(projects, projectKey);
      try {
        return readdirSync(dir)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => ({ sessionId: f.slice(0, -6), mtime: Math.floor(statSync(join(dir, f)).mtimeMs) }));
      } catch {
        return [];
      }
    },
    async listSubkeys({ projectKey, sessionId }) {
      const root = join(projects, projectKey, sessionId);
      const out: string[] = [];
      const walk = (d: string) => {
        for (const e of existsSync(d) ? readdirSync(d, { withFileTypes: true }) : []) {
          if (e.isDirectory()) walk(join(d, e.name));
          else if (e.name.endsWith(".jsonl")) out.push(relative(root, join(d, e.name)).slice(0, -6));
        }
      };
      walk(root);
      return out;
    },
    async delete(key) {
      if (safe(key)) rmSync(fileOf(key), { force: true });
    },
  };
}

/** The Claude home a session's files are in: its credential's account home, else ~/.claude. */
export const claudeHomeOf = (nativeId: string) => claudeHome(sessionCredential(`claude-code:${nativeId}`));

/** Options for the SDK's history calls about this session: a store over its account home, none on the machine's login. */
export function homeOptions(nativeId: string): { sessionStore?: SessionStore } {
  const cred = sessionCredential(`claude-code:${nativeId}`);
  if (!cred) return {};
  const home = claudeHome(cred);
  return home === claudeHome() ? {} : { sessionStore: homeSessionStore(home) };
}

/** The account homes Claude Code sessions run on (other than ~/.claude), for listing their sessions. */
export function accountClaudeHomes(): string[] {
  const own = claudeHome();
  const homes = new Set<string>();
  for (const [id, s] of Object.entries(config().sessions ?? {}))
    if (id.startsWith("claude-code:") && s?.credential) {
      const h = claudeHome(s.credential);
      if (h !== own) homes.add(h);
    }
  return [...homes];
}
