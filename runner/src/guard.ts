// The guard: one approval policy for every harness, so agents can run unattended without being
// able to do anything they like.
//
//   ask   rules auto-allow the clearly safe; everything else waits for a person in the UI
//   auto  rules decide what they can; a small model judges the rest against the session's goal;
//         nothing waits for a person. Denials go back to the agent with a reason, so it adapts.
//   full  allow everything (rely on the harness sandbox / checkpoints)
//
// Rules are deliberately conservative: hard-deny the catastrophic, auto-allow reads, in-project
// edits and ordinary dev commands, and send everything else to the judge.

import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { config } from "./config";
import { parseJsonReply, runBackground } from "./context/background";

export type GuardMode = "ask" | "edits" | "auto" | "full";
export const GUARD_MODES: GuardMode[] = ["ask", "edits", "auto", "full"];

export interface ToolCall {
  tool: string;
  input: any;
  cwd: string;
}

export interface Verdict {
  decision: "allow" | "deny" | "unsure";
  by: "rule" | "judge" | "user" | "mode";
  reason: string;
}

const HOME = homedir();

// ---------------- tool classification ----------------

type Kind = "read" | "edit" | "shell" | "web" | "meta" | "mcp" | "browser" | "other";

const KINDS: [RegExp, Kind][] = [
  [/^(read|view_file|view_file_outline|view_code_item|glob|grep|grep_search|find_by_name|list_dir|list|ls|search|codebase_search|notebookread|lsp)$/i, "read"],
  [/^(edit|multiedit|write|notebookedit|write_to_file|replace_file_content|multi_replace_file_content|str_replace_based_edit_tool|apply_patch|delete|move)$/i, "edit"],
  [/^(bash|shell|exec|execute|run_command|run_terminal_cmd|bashoutput|killshell|send_command_input|command_status)$/i, "shell"],
  [/^(webfetch|websearch|codesearch|fetch|read_url_content|search_web|web_search|web_fetch)$/i, "web"],
  [/^(task|agent|todowrite|todoread|think|exitplanmode|enterplanmode|skill|slashcommand|toolsearch|plan|update_plan)$/i, "meta"],
  [/^mcp__/i, "mcp"],
  [/^browser_/i, "browser"],
];

export function kindOf(tool: string): Kind {
  for (const [re, k] of KINDS) if (re.test(tool)) return k;
  return "other";
}

function pathOf(input: any): string | undefined {
  const p = input?.file_path ?? input?.filePath ?? input?.path ?? input?.notebook_path ?? input?.AbsolutePath ?? input?.TargetFile ?? input?.SearchPath ?? input?.DirectoryPath;
  return typeof p === "string" ? p : undefined;
}

export function commandOf(input: any): string | undefined {
  const c = input?.command ?? input?.CommandLine ?? input?.cmd;
  return typeof c === "string" ? c : Array.isArray(c) ? c.join(" ") : undefined;
}

function abs(p: string, cwd: string) {
  return resolve(cwd, p.replace(/^~(?=$|\/)/, HOME));
}

function inside(p: string, dir: string) {
  return p === dir || p.startsWith(dir.replace(/\/$/, "") + "/");
}

const SENSITIVE = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.config\/gcloud(\/|$)/,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)\.env(\.(?!example$|sample$|template$|dist$)[\w.-]+)?$/,
  /(^|\/)\.pi\/agent\/auth\.json$/,
  /(^|\/)\.claude\/\.credentials\.json$/,
  /(^|\/)\.codex\/auth\.json$/,
  /(^|\/)\.local\/share\/opencode\/auth\.json$/,
  /(^|\/)\.config\/tether\//,
  /(^|\/)\.config\/fol(iation)?\//,
  /id_(rsa|ed25519|ecdsa)(\.pub)?$/,
  /\.(pem|key|p12|pfx)$/,
  /credentials(\.json)?$/i,
];

const isSensitive = (p: string) => SENSITIVE.some((re) => re.test(p));

// ---------------- shell commands ----------------

const HARD_DENY: [RegExp, string][] = [
  [/(^|[\s;&|(])sudo\s/, "runs as root"],
  [/(^|[\s;&|(])su(\s|$)/, "switches user"],
  [/\brm\s+(-[a-zA-Z]*\s+)*(\/|~|\$HOME|\/\*|\.\.)(\s|\/?$)/, "deletes outside the project (/, ~ or ..)"],
  [/\b(mkfs|fdisk|parted|wipefs)\b/, "formats disks"],
  [/\bdd\b[^|;&]*\bof=\/dev\//, "writes raw devices"],
  [/>\s*\/dev\/(sd|nvme|xvd|vd)/, "writes raw devices"],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bomb"],
  [/\b(shutdown|reboot|poweroff|halt)\b/, "shuts the machine down"],
  [/\bsystemctl\s+(stop|disable|mask|kill)\b/, "stops system services"],
  [/\bgit\s+push\b[^;&|]*(--force\b|--force-with-lease\b|\s-f\b|\s\+\S)/, "force-pushes (rewrites shared history)"],
  [/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, "pipes a download into a shell"],
  [/\bchmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/, "opens permissions on /"],
  [/\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b/, "publishes a package"],
  [/\bcrontab\s+(-r|-e)?\b/, "changes scheduled jobs"],
  [/(^|\/)\.ssh\/|id_(rsa|ed25519)|\.aws\/credentials|\.git-credentials|\.netrc\b/, "touches credentials"],
  [/\bhistory\s+-c\b|\bshred\b/, "destroys evidence"],
];

const SAFE_HEADS = new Set(
  (
    "ls cat head tail wc grep egrep rg ag sort uniq diff cmp echo printf pwd which whereis type file stat du df tree basename " +
    "dirname realpath readlink date true false test [ cd jq yq cut tr paste column nl comm fold seq sleep env-less " +
    "mkdir touch cp mv ln sed awk node bun deno python python3 go cargo rustc rustup make cmake tsc eslint prettier biome " +
    "pytest jest vitest mocha ruby java javac mvn gradle dotnet swift zig elixir mix php composer black ruff mypy pyright " +
    "gofmt rustfmt clippy-driver golangci-lint shellcheck hadolint terraform-fmt cloc tokei hexdump xxd od strings md5sum sha256sum"
  ).split(" "),
);

const GIT_SAFE = new Set(
  "status diff log show branch add commit checkout switch restore stash fetch pull rev-parse ls-files ls-tree blame grep tag worktree mv rm init remote merge rebase cherry-pick describe shortlog reflog notes bisect apply am format-patch config".split(" "),
);

function splitSegments(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokens(seg: string): string[] {
  const out: string[] = [];
  for (const m of seg.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]!);
  while (out.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0]!)) out.shift(); // FOO=bar cmd
  return out;
}

function classifyShell(cmd: string, cwd: string): Verdict | undefined {
  for (const [re, why] of HARD_DENY) if (re.test(cmd)) return { decision: "deny", by: "rule", reason: `Blocked: ${why}.` };
  if (/\$\(|`|<\(|>\(/.test(cmd)) return undefined; // substitutions can hide anything: judge
  if (/\$/.test(cmd)) return undefined; // $HOME/…, ${X}: the path checks below can't see where it points
  // Redirects must stay in the project (or /tmp, /dev/null).
  for (const m of cmd.matchAll(/(?:^|[^<>&\d])>{1,2}\s*([^\s;&|]+)/g)) {
    const target = m[1]!;
    if (target.startsWith("&")) continue;
    const p = abs(target, cwd);
    if (!(inside(p, cwd) || inside(p, "/tmp") || p === "/dev/null") || isSensitive(p)) return undefined;
  }
  for (const seg of splitSegments(cmd)) {
    const t = tokens(seg);
    if (!t.length) continue;
    const head = basename(t[0]!);
    const args = t.slice(1);
    if (head === "git") {
      const sub = args.find((a) => !a.startsWith("-"));
      if (!sub || !GIT_SAFE.has(sub)) return undefined;
      if (sub === "config" && args.some((a) => a === "--global" || a === "--system")) return undefined;
      if (sub === "branch" && args.some((a) => a === "-D")) return undefined;
      continue;
    }
    if (["npm", "pnpm", "yarn", "bun"].includes(head)) {
      const sub = args[0] ?? "";
      if (["install", "i", "ci", "add"].includes(sub)) {
        // Installing the project's own lockfile is routine; adding new packages is judged.
        if (args.slice(1).some((a) => !a.startsWith("-"))) return undefined;
        continue;
      }
      if (["run", "test", "t", "build", "start", "lint", "typecheck", "dev"].includes(sub)) continue;
      if (head === "bun" && args[0] && /\.(ts|js|tsx|mjs)$/.test(args[0])) continue;
      if (args.length === 0 || /^-/.test(sub)) continue;
      return undefined;
    }
    if (["pip", "pip3", "uv", "poetry"].includes(head)) {
      const sub = args.join(" ");
      if (/^(sync|run|lock|install\s+-r|install\s+-e\s+\.|install\s*$|list|show|freeze)/.test(sub)) continue;
      return undefined;
    }
    if (head === "find" && args.some((a) => ["-delete", "-exec", "-execdir", "-ok"].includes(a))) return undefined;
    if (head === "sed" && args.some((a) => a.startsWith("-i")) && args.some((a) => !a.startsWith("-") && isAbsolute(a) && !inside(a, cwd))) return undefined;
    if (head === "rm" || head === "mv" || head === "cp" || head === "ln" || head === "touch" || head === "mkdir") {
      const paths = args.filter((a) => !a.startsWith("-")).map((a) => abs(a, cwd));
      const touchesGitDir = paths.some((p) => inside(p, resolve(cwd, ".git")));
      if (paths.some((p) => !(inside(p, cwd) || inside(p, "/tmp")) || isSensitive(p)) || touchesGitDir) return undefined;
      if (head === "rm" && paths.some((p) => p === cwd)) return undefined;
      continue;
    }
    if (["cat", "head", "tail", "less", "grep", "rg"].includes(head) && args.some((a) => isSensitive(abs(a, cwd)))) {
      return { decision: "deny", by: "rule", reason: "Blocked: reads a credential or secrets file." };
    }
    if (SAFE_HEADS.has(head)) continue;
    return undefined; // unknown program: judge
  }
  return { decision: "allow", by: "rule", reason: "Routine project command." };
}

// ---------------- rules ----------------

/**
 * Tether's own MCP server (runner/src/context/mcp.ts) only reads and writes the context store.
 * Harnesses name its tools differently: `mcp__tether-context__x` (Claude, Codex cards),
 * `tether-context_x` (opencode), `tether_context_x` or `mcp({ tool })` (pi-mcp-adapter).
 */
export function isContextTool(tool: string, input: any): boolean {
  if (/^(mcp__tether-context__|tether[-_]context[_./])\w+$/i.test(tool)) return true;
  return tool === "mcp" && (input?.server === "tether-context" || /^tether[-_]context[_.]/.test(String(input?.tool ?? "")));
}

export function rules(call: ToolCall): Verdict | undefined {
  if (isContextTool(call.tool, call.input)) return { decision: "allow", by: "rule", reason: "Tether memory and skills." };
  const kind = kindOf(call.tool);
  const cwd = call.cwd;
  switch (kind) {
    case "meta":
      return { decision: "allow", by: "rule", reason: "Planning / bookkeeping tool." };
    case "read": {
      const p = pathOf(call.input);
      if (p && isSensitive(abs(p, cwd))) return { decision: "deny", by: "rule", reason: "Blocked: reads a credential or secrets file." };
      return { decision: "allow", by: "rule", reason: "Read-only." };
    }
    case "edit": {
      const p = pathOf(call.input);
      if (!p) return undefined;
      const a = abs(p, cwd);
      if (isSensitive(a)) return { decision: "deny", by: "rule", reason: "Blocked: writes a credential or secrets file." };
      if (inside(a, resolve(cwd, ".git"))) return undefined; // git internals (hooks run code later)
      if (inside(a, cwd) || inside(a, "/tmp")) return { decision: "allow", by: "rule", reason: "Edits inside the project." };
      return undefined;
    }
    case "shell": {
      const cmd = commandOf(call.input);
      if (!cmd) return call.tool.match(/output|status|kill/i) ? { decision: "allow", by: "rule", reason: "Shell bookkeeping." } : undefined;
      const wd = typeof call.input?.Cwd === "string" ? abs(call.input.Cwd, cwd) : cwd;
      if (!inside(wd, cwd) && !inside(wd, "/tmp")) return undefined;
      return classifyShell(cmd, cwd);
    }
    case "web":
      return { decision: "allow", by: "rule", reason: "Web read." };
    default:
      return undefined; // mcp, browser, other: judge
  }
}

// ---------------- judge ----------------

const JUDGE_SYSTEM = `You are the safety gate for an autonomous coding agent working unattended in a developer's repository.
Decide whether ONE tool call may run. Answer with JSON only: {"decision":"allow"|"deny","reason":"<one sentence>"}.

Allow when the call plausibly serves the user's task and its effects stay within the project or are routine for development
(running the project's code and tests, installing dependencies the task needs from official registries, local git operations,
read-only queries to remote services).

Deny when it could cause harm that is hard to undo or reaches beyond the project: deleting or overwriting data outside the
project; reading, printing or sending secrets/credentials; exfiltrating code or data to unknown hosts; changing system or
global configuration; affecting shared or production systems (deploys, releases, publishing, database migrations against
non-local databases, sending emails/messages, merging or pushing to protected branches) unless the user's task explicitly asks
for exactly that; installing software from untrusted sources; disabling security controls; or anything you can't understand.

When denying, say what the agent should do instead if there is a safer way.`;

const cache = new Map<string, Verdict>();

export async function judge(call: ToolCall, goal: string): Promise<Verdict> {
  const g = config().guard ?? {};
  if (g.judgeModel === "off") return { decision: "deny", by: "judge", reason: "Not covered by the safety rules, and the judge is turned off." };
  const key = JSON.stringify([call.cwd, call.tool, call.input]);
  const hit = cache.get(key);
  if (hit) return hit;
  const prompt = `User's task (latest instructions last):\n${goal || "(unknown)"}\n\nProject directory: ${call.cwd}\n\nTool call:\n${JSON.stringify({ tool: call.tool, input: call.input }, null, 2).slice(0, 6000)}`;
  try {
    // The shared background model (Settings → Background model), Haiku via Claude by default.
    const text = await runBackground({ system: JUDGE_SYSTEM, prompt, cwd: call.cwd, timeoutMs: 60_000 });
    const json = parseJsonReply(text);
    const v: Verdict = { decision: json.decision === "allow" ? "allow" : "deny", by: "judge", reason: String(json.reason ?? "").slice(0, 400) };
    if (cache.size > 2000) cache.clear();
    cache.set(key, v);
    return v;
  } catch (e: any) {
    return { decision: "deny", by: "judge", reason: `Couldn't get a safety verdict (${e?.message ?? e}); denied to be safe. Try a more conventional way.` };
  }
}
