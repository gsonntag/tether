// The background model: one setting ("harness:model") for the small, tool-less model calls the
// runner makes on its own (the guard's safety judge, the memory merge pass). It runs through the
// harness's own login, so it draws on the same plan as sessions:
//   claude-code  Claude Agent SDK, one turn, no tools          (default: claude-code:haiku)
//   codex        `codex exec`, read-only sandbox, ephemeral
//   pi           `pi -p`, no tools, extensions or session

import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEntry, type HarnessId } from "../../../web/src/shared/protocol";
import { config } from "../config";

export interface BackgroundRequest {
  system: string;
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
}

type Runner = (model: string, req: BackgroundRequest) => Promise<string>;

export const DEFAULT_BACKGROUND_MODEL = "claude-code:haiku";

/** The configured background model. Older configs only had the judge's Claude model. */
export function backgroundModel(): string {
  const cfg = config();
  if (cfg.backgroundModel) return cfg.backgroundModel;
  const judge = cfg.guard?.judgeModel;
  return judge && judge !== "off" ? `claude-code:${judge}` : DEFAULT_BACKGROUND_MODEL;
}

const claude: Runner = async (model, req) => {
  const q = query({
    prompt: req.prompt,
    options: {
      model,
      systemPrompt: req.system,
      maxTurns: 1,
      tools: [],
      settingSources: [],
      persistSession: false,
      cwd: req.cwd ?? tmpdir(),
      pathToClaudeCodeExecutable: process.env.CLAUDE_BIN ?? Bun.which("claude") ?? undefined,
    },
  });
  let text = "";
  const timer = setTimeout(() => q.close(), req.timeoutMs ?? 60_000);
  try {
    for await (const m of q) if (m.type === "result" && (m as any).result) text = (m as any).result;
  } finally {
    clearTimeout(timer);
  }
  return text;
};

async function run(cmd: string[], opts: { cwd: string; stdin?: string; timeoutMs: number }): Promise<string> {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, stdin: opts.stdin !== undefined ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe", timeout: opts.timeoutMs });
  if (opts.stdin !== undefined) {
    const sink = p.stdin as import("bun").FileSink;
    sink.write(opts.stdin);
    await sink.end();
  }
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${err.trim().split("\n").slice(-2).join(" ")}`);
  return out;
}

const codex: Runner = async (model, req) => {
  const dir = mkdtempSync(join(tmpdir(), "tether-bg-"));
  try {
    const outFile = join(dir, "last.txt");
    const args = [process.env.CODEX_BIN ?? "codex", "exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "-o", outFile];
    if (model && model !== "default") args.push("-m", model);
    args.push("-");
    await run(args, { cwd: dir, stdin: `${req.system}\n\n---\n\n${req.prompt}`, timeoutMs: req.timeoutMs ?? 120_000 });
    return readFileSync(outFile, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const pi: Runner = async (model, req) => {
  const args = [process.env.PI_BIN ?? "pi", "-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--system-prompt", req.system];
  if (model && model !== "default") args.push("--model", model);
  args.push(req.prompt);
  return run(args, { cwd: tmpdir(), timeoutMs: req.timeoutMs ?? 120_000 });
};

const RUNNERS: Partial<Record<HarnessId, Runner>> = { "claude-code": claude, codex, pi };

export const BACKGROUND_HARNESSES = Object.keys(RUNNERS) as HarnessId[];

/** Runs one prompt on the background model (or `model`) and returns the reply text. */
export async function runBackground(req: BackgroundRequest, model = backgroundModel()): Promise<string> {
  const e = parseEntry(model, "claude-code");
  const r = RUNNERS[e.harness];
  if (!r) throw new Error(`${e.harness} can't run background work (use ${BACKGROUND_HARNESSES.join(", ")})`);
  return r(e.model, req);
}

/** The first JSON object in a model reply. */
export function parseJsonReply<T = any>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON in the reply");
  return JSON.parse(text.slice(start, end + 1));
}
