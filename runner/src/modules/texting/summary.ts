// Plain-English summaries for request texts (SPEC §11 Texting): a person reading a text on their phone
// gets what the agent wants to do, as the end of "Can I …?", never the raw command or the harness's
// warning. Deterministic: the tool call's own `description` (Claude Code's Bash tool has
// one) when there is one, else a reading of the command's programs, the riskiest first. The full
// command stays in Tether, where the text's link opens the request.

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);
const bare = (s: string) => s.trim().replace(/[.!\s]+$/, "");

/** What a known program in a command does, by how risky it is (lower: said first). */
interface Act {
  risk: number;
  words: string;
}

function gitAct(args: string[]): Act {
  const sub = args.find((a) => !a.startsWith("-")) ?? "";
  const rest = args.slice(args.indexOf(sub) + 1);
  const has = (f: string) => args.includes(f);
  switch (sub) {
    case "push":
      return has("--force") || has("-f") || rest.some((a) => a.startsWith("--force")) ? { risk: 0, words: "force-push code" } : { risk: 1, words: "push code" };
    case "reset":
      return has("--hard") ? { risk: 0, words: "throw away uncommitted changes" } : { risk: 3, words: "reset git state" };
    case "clean":
      return { risk: 0, words: "delete untracked files" };
    case "worktree":
      return rest[0] === "remove" ? { risk: 1, words: "clean up a worktree" } : rest[0] === "add" ? { risk: 3, words: "make a worktree" } : { risk: 5, words: "check worktrees" };
    case "branch":
      return has("-D") || has("-d") ? { risk: 2, words: "delete a branch" } : { risk: 5, words: "check branches" };
    case "commit":
      return { risk: 3, words: "commit changes" };
    case "merge":
    case "rebase":
      return { risk: 2, words: `${sub} branches` };
    case "checkout":
    case "switch":
    case "restore":
      return { risk: 3, words: "switch or restore files" };
    case "clone":
      return { risk: 3, words: "download a repo" };
    default:
      return { risk: 6, words: "check the git repo" };
  }
}

function actOf(prog: string, args: string[]): Act | undefined {
  const flags = args.filter((a) => a.startsWith("-")).join("");
  switch (prog) {
    case "rm":
      return { risk: 0, words: /r/i.test(flags) ? "delete folders" : "delete files" };
    case "rmdir":
    case "shred":
    case "unlink":
      return { risk: 0, words: "delete files" };
    case "git":
      return gitAct(args);
    case "gh":
      return args[0] === "pr" && args[1] === "merge" ? { risk: 1, words: "merge a PR" } : args[0] === "pr" && args[1] === "create" ? { risk: 2, words: "open a PR" } : { risk: 4, words: "use GitHub" };
    case "sudo":
      return { risk: 0, words: "run something as admin" };
    case "kill":
    case "pkill":
    case "killall":
      return { risk: 1, words: "stop running programs" };
    case "systemctl":
      return { risk: 1, words: `${["restart", "stop", "start"].includes(args.find((a) => !a.startsWith("-")) ?? "") ? args.find((a) => !a.startsWith("-")) : "change"} a service` };
    case "mv":
      return { risk: 2, words: "move files" };
    case "chmod":
    case "chown":
      return { risk: 2, words: "change file permissions" };
    case "curl":
    case "wget":
      return { risk: 2, words: "reach the internet" };
    case "ssh":
    case "scp":
    case "rsync":
      return { risk: 2, words: "reach another machine" };
    case "docker":
      return { risk: 2, words: "run Docker" };
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
    case "bunx":
    case "npx":
    case "pip":
    case "pip3":
    case "cargo":
    case "go": {
      const sub = args.find((a) => !a.startsWith("-")) ?? "";
      if (/^(install|i|add|ci|remove|uninstall)$/.test(sub)) return { risk: 3, words: "install packages" };
      if (/^test/.test(sub) || args.includes("test")) return { risk: 4, words: "run the tests" };
      if (/build|typecheck|tsc|lint/.test(args.join(" "))) return { risk: 4, words: "build the code" };
      return { risk: 4, words: `run ${prog}` };
    }
    case "pytest":
    case "jest":
    case "vitest":
      return { risk: 4, words: "run the tests" };
    case "make":
      return { risk: 4, words: "run make" };
    case "mkdir":
    case "touch":
    case "cp":
    case "tee":
      return { risk: 4, words: "write files" };
    case "python":
    case "python3":
    case "node":
    case "sh":
    case "bash":
      return { risk: 3, words: "run a script" };
    case "cat":
    case "ls":
    case "head":
    case "tail":
    case "grep":
    case "rg":
    case "find":
    case "wc":
    case "echo":
    case "printf":
    case "sed":
    case "awk":
    case "diff":
    case "pwd":
    case "true":
    case "test":
    case "[":
    case "sleep":
    case "date":
      return { risk: 7, words: "look at files" };
    default:
      return undefined;
  }
}

/** The programs a command runs, with their arguments: segments split at ; && || | and newlines, shell keywords and VAR=x left out. */
export function programs(command: string): { prog: string; args: string[] }[] {
  const out: { prog: string; args: string[] }[] = [];
  const noQuotes = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "x");
  for (const seg of noQuotes.split(/\n|;|&&|\|\||\||\$\(|`|\)/)) {
    let words = seg.trim().split(/\s+/).filter(Boolean);
    while (words.length && (/^(do|then|else|elif|if|while|until|done|fi|esac|time|nohup|env|exec|!|\{|\})$/.test(words[0]!) || /^[A-Za-z_]\w*=/.test(words[0]!))) words = words.slice(1);
    if (!words.length || words[0] === "for" || words[0] === "case") continue;
    // "sudo X": as admin, and X too.
    if (words[0] === "sudo") {
      out.push({ prog: "sudo", args: [] });
      words = words.slice(1).filter((w, i, all) => !(w.startsWith("-") && all.slice(0, i).every((x) => x.startsWith("-"))));
      if (!words.length) continue;
    }
    const prog = words[0]!.replace(/^.*\//, "");
    if (prog === "cd") continue;
    out.push({ prog, args: words.slice(1) });
  }
  return out;
}

/** "the hide-checkin worktree": a worktree the command names, if one. */
function worktreeOf(command: string): string | undefined {
  return /\.claude\/worktrees\/([\w.-]+)/.exec(command)?.[1] ?? /\/worktrees\/([\w.-]+)/.exec(command)?.[1];
}

/** What a shell command does, in a few plain words ("delete folders and check the git repo (hide-checkin worktree)"). */
export function commandWords(command: string, description?: string): string {
  const tree = worktreeOf(command);
  const where = tree ? ` (in the ${tree} worktree)` : "";
  // The agent's own words for it.
  if (description?.trim()) return lowerFirst(bare(description));
  const acts: Act[] = [];
  const unknown: string[] = [];
  for (const { prog, args } of programs(command)) {
    const a = actOf(prog, args);
    if (a) {
      if (!acts.some((x) => x.words === a.words)) acts.push(a);
    } else if (!unknown.includes(prog) && /^[\w.+-]{1,30}$/.test(prog)) unknown.push(prog);
  }
  const shown = acts.sort((a, b) => a.risk - b.risk).filter((a, i) => i < 2 || a.risk <= 1).slice(0, 3).map((a) => a.words);
  // Removing a worktree it names is the point: the deletes around it are part of the cleanup.
  if (tree && shown.includes("clean up a worktree")) return `clean up the ${tree} worktree`;
  const at = where;
  if (!shown.length) return unknown.length ? `run ${unknown.slice(0, 2).join(" and ")}${at}` : `run a shell command${at}`;
  const said = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0]!;
  return `${said}${at}`;
}

/** A path's last two parts ("src/app.css"): enough to recognize on a phone. */
export const shortPath = (p: string) => p.replace(/\/+$/, "").split("/").slice(-2).join("/");

/** An MCP tool's readable name: mcp__github__create_issue → "create issue (github)". */
export function toolWords(tool: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tool);
  return m ? `${m[2]!.replace(/_/g, " ")} (${m[1]})` : tool;
}
