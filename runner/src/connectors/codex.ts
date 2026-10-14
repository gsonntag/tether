// Codex (app-server): memory as developer instructions and in ~/.codex/AGENTS.md; `tether-context`
// as a thread `config` override and in ~/.codex/config.toml; skills run from a `skill` input item
// (codexInput turns `/name` into one).

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { invocationText } from "../../../web/src/shared/skill";
import { upsertTomlBlock } from "../context/blocks";
import { mcpLaunch, SESSION_TOOL_TIMEOUT_S } from "../context/launch";
import { harness } from "../context/paths";
import { toEntry } from "../mcp/formats";
import { codexServers } from "../mcp/sources";
import { codexAgentConfig } from "../subagents";
import { cap, envSlot, repoDirs, slot } from "./shared";
import type { Connector, ExportContext, SessionCtx } from "./types";

/** `[mcp_servers.tether-context]` in a managed block of ~/.codex/config.toml. */
function registerCodexMcp(x: ExportContext) {
  const { out } = x;
  const path = harness.codexConfig();
  if (!existsSync(dirname(path))) return;
  const cur = x.readText(path);
  if (/^\s*\[mcp_servers\.("?)tether-context\1\]/m.test(cur.replace(/# tether:begin[\s\S]*?# tether:end/, ""))) {
    out.mcpConfigs.push(path); // the user registered it themselves
    return;
  }
  const l = mcpLaunch();
  const toml = [
    `[mcp_servers.tether-context]`,
    `command = ${JSON.stringify(l.command)}`,
    `args = [${l.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    `default_tools_approval_mode = "approve"`,
    `tool_timeout_sec = ${SESSION_TOOL_TIMEOUT_S}`,
    `[mcp_servers.tether-context.env]`,
    ...Object.entries(l.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`),
  ].join("\n");
  x.writeOwned(path, upsertTomlBlock(cur, toml));
  out.mcpConfigs.push(path);
}

/** Thread `config` overrides (`mcp_servers.<name>`): the registry's servers Codex can take, and `tether-context`. */
function codexMcp({ context, servers }: SessionCtx) {
  const config: Record<string, unknown> = {};
  for (const s of servers ?? []) {
    const e = toEntry(s.transport, "codex");
    if (e) config[`mcp_servers.${s.name}`] = e;
  }
  if (context)
    config["mcp_servers.tether-context"] = {
      command: context.mcp.command,
      args: context.mcp.args,
      env: context.mcp.env,
      default_tools_approval_mode: "approve",
      // ask_user waits for the user; Codex's default is 60 s.
      tool_timeout_sec: SESSION_TOOL_TIMEOUT_S,
    };
  return Object.keys(config).length ? { options: { config } } : undefined;
}

export const codexConnector: Connector = {
  id: "codex",
  memory: {
    capability: () => cap("native", "Developer instructions; also ~/.codex/AGENTS.md"),
    forSession: ({ context }) => (context?.prompt ? { options: { developerInstructions: context.prompt } } : undefined),
    globalBlock: (_globalFile, digest) => [harness.codexAgentsMd(), digest],
  },
  mcp: {
    capability: () => cap("native", "Per-thread config override; ~/.codex/config.toml"),
    forSession: codexMcp,
    exportGlobal: registerCodexMcp,
    importGlobal: codexServers,
    native: () => codexServers().found,
    // codex-cli 0.162 (rmcp-client executor_process_transport): a stdio server gets HOME, LOGNAME,
    // PATH, SHELL, USER, LANG, LC_ALL, TERM, TMPDIR, TZ and its own `env`, nothing else.
    filtersEnv: true,
    deliver: (t) => (t.type === "sse" ? { how: "none", note: "Codex connects only to streamable HTTP servers, not SSE" } : { how: "session", note: "Per session (thread config)" }),
    targets: () => [{ file: harness.codexConfig(), installed: existsSync(harness.codexDir()), format: "toml", flavor: "codex" }],
  },
  skills: {
    capability: () => cap("native", "Runs the skills it lists as skill items"),
    invoke: invocationText,
    dirs: (projectPath) => [
      ...repoDirs(projectPath, ".agents/skills"),
      ...repoDirs(projectPath, ".codex/skills"),
      { dir: harness.codexSkills(), source: "codex" },
      { dir: harness.agentsSkills(), source: "agents" },
    ],
    offline: true,
    installDirs: () => [{ harness: "codex", dir: harness.codexSkills(), install: false, skip: [] }],
  },
  // Older Codex read custom prompts from ~/.codex/prompts/*.md; codex-cli 0.162 has no loader for
  // them left (checked in its binary): skills are its custom commands now.
  commands: slot("emulated", "No custom commands in this version (its skills took their place; older versions read ~/.codex/prompts): Tether fills in your commands and sends them as the message"),
  // codex-cli 0.162: agent roles are `[agents.<name>] { description, config_file }`, the role file a
  // config layer with developer_instructions; a thread's config override takes them per session.
  agents: {
    capability: () => cap("native", "Your subagents per session as agent roles (thread config agents.<name>, a role file with its instructions); their tools and model aren't carried over"),
    forSession: () => {
      const config = codexAgentConfig();
      return Object.keys(config).length ? { options: { config } } : undefined;
    },
  },
  hooks: slot("emulated", "Run by Tether: PreToolUse at its approval requests (its known-safe read-only commands never ask, so they skip it; Full access asks again while you have one), PostToolUse as items finish, Stop and UserPromptSubmit around turns. Its own hooks can't be added per session without your review in Codex, and the ones it already runs from its trusted config run only there"),
  env: envSlot("Your secrets in the app-server's environment; MCP servers Tether hands it get them too. Codex starts MCP servers with a short allow-listed environment, so the servers in your own Codex config don't get them"),
  goal: slot("native", "Mirrored into Codex's thread goal (thread/goal/set), status synced back; Tether's loop continues when Codex doesn't"),
  // Checked with codex-cli 0.162: plan mode (collaborationMode "plan") ends its turn on a `plan`
  // item; the TUI's "Implement this plan?" prompt is client-side, the app-server has no review step.
  plan: slot("emulated", "Plan mode has no review over the app-server: Tether's review card when a plan-mode turn ends; Approve switches to Default and sends \"Implement the plan.\""),
  todos: slot("native", "Its plan checklist (turn/plan/updated), kept as the session's todo list; todo_set also works"),
  ask_user: slot("native", "Its request_user_input as a question card; ask_user (tether-context) also works"),
  // codex-cli 0.162 app-server: no scheduling requests; ScheduledTaskSummary only describes a plugin's tasks.
  schedules: slot("emulated", "Tether's /loop and /schedule, run by the runner; Codex's app-server has no schedules of its own"),
  // codex-cli 0.162 app-server: thread/fork keeps whole turns (lastTurnId); thread/compact/start takes no instructions.
  fork: slot("native", "Its own fork (thread/fork) where a turn ends, into Codex; at a message inside a turn, in the turn running now or into another harness, a new session on a brief"),
  compact: slot("native", "Its own compaction (thread/compact/start); it takes no focus, so /compact with a focus restarts the conversation on a brief"),
  // codex-cli 0.162 review/start reviews uncommitted changes, a branch, a commit or custom
  // instructions and returns its findings as text only (exitedReviewMode.review).
  crossAgents: slot("emulated", "agent_start / agent_wait / agent_result in tether-context (thread config): starts any installed harness and model as a Tether session in its own worktree; its own multi-agent tools stay for Codex helpers"),
  review: slot("emulated", "Tether's review session in its read-only sandbox, findings through review_report; its own review/start can't take the session's diff and returns its findings as text only"),
};
