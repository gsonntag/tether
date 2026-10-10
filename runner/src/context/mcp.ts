// `tether-context`: the master context as an MCP server, so any harness can search and write the
// shared memory and read the skill library.
//
//   bun runner/src/context/mcp.ts      (stdio; TETHER_CONTEXT_DIR points at the store)
//
// Reads come straight from the store. Writes don't touch memory files: memory_write drops the
// note in the store's inbox, and the runner's merge pass (dedupe, update, conflicts, commit)
// takes it from there, so every write goes through the same path as imported memory.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_TYPES, sha } from "./format";
import { contextDir } from "./paths";
import { repoKey } from "./repokey";
import { sections } from "./sources";
import { listSkills, readMeta, skillFile } from "./skills";
import { Store, writeAtomic } from "./store";

const TOOLS = [
  {
    name: "memory_search",
    description:
      "Search the user's shared long-term memory (preferences, feedback, project facts) kept by Tether across all coding agents. Searches global memory and this repository's memory by default.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for" },
        scope: { type: "string", enum: ["all", "global", "repo"], description: "global: about the user; repo: this repository; all (default): both" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_get",
    description: "Read one memory entry in full, by the id or name memory_search returned.",
    inputSchema: { type: "object", properties: { slug: { type: "string", description: "id (e.g. global/user-role) or name" } }, required: ["slug"] },
  },
  {
    name: "memory_write",
    description:
      "Save one durable fact to the shared memory (a user preference, a correction to how agents should work, a non-obvious project fact). One fact per call, self-contained. It is merged with existing memory (duplicates and contradictions are handled).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The fact, as a short markdown note" },
        type: { type: "string", enum: MEMORY_TYPES, description: "user: who they are; feedback: how they want agents to work; project: about this project; reference: pointer to docs" },
        scope: { type: "string", enum: ["global", "repo"], description: "global: true everywhere; repo: only this repository. Omit to let Tether decide." },
      },
      required: ["text"],
    },
  },
  { name: "skill_list", description: "List the skills in the user's shared skill library.", inputSchema: { type: "object", properties: {} } },
  {
    name: "skill_get",
    description: "Read a skill's instructions (SKILL.md) from the shared library, plus the list of its supporting files.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
];

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

/** The repo's own CLAUDE.md / AGENTS.md: searchable context, not memory. */
function repoDocs(cwd: string, query: string): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const out: string[] = [];
  for (const f of ["CLAUDE.md", "AGENTS.md"]) {
    const p = join(cwd, f);
    if (!existsSync(p)) continue;
    for (const s of sections(readFileSync(p, "utf8"))) {
      const text = `${s.title}\n${s.body}`.toLowerCase();
      if (terms.length && terms.some((t) => text.includes(t))) out.push(`[${f}${s.title ? ` › ${s.title}` : ""}]\n${s.body.slice(0, 800)}`);
    }
  }
  return out.slice(0, 3);
}

export async function callTool(name: string, args: any, cwd = process.cwd()): Promise<Result> {
  const store = new Store(contextDir());
  switch (name) {
    case "memory_search": {
      const query = String(args?.query ?? "");
      const key = `repo:${await repoKey(cwd)}`;
      const scope = args?.scope === "global" ? ["global"] : args?.scope === "repo" ? [key] : ["global", key];
      const hits = store.search(query, scope, 10);
      const docs = scope.includes(key) ? repoDocs(cwd, query) : [];
      if (!hits.length && !docs.length) return ok("No matching memory.");
      const lines = hits.map((m) => `- ${m.id} (${m.type}, ${m.scope}): ${m.description}\n  ${m.body.replace(/\s+/g, " ").slice(0, 240)}`);
      if (docs.length) lines.push("", "From this repository's own docs:", ...docs);
      return ok(lines.join("\n"));
    }
    case "memory_get": {
      const want = String(args?.slug ?? "").trim();
      const key = `repo:${await repoKey(cwd)}`;
      const all = store.list();
      const rank = (s: string) => (s === key ? 0 : s === "global" ? 1 : 2);
      const m = all.find((x) => x.id === want) ?? all.filter((x) => x.slug === want || x.name === want).sort((a, b) => rank(a.scope) - rank(b.scope))[0];
      if (!m) return fail(`No memory "${want}". Use memory_search to find ids.`);
      return ok(`# ${m.name}\n${m.description}\n\ntype: ${m.type} · scope: ${m.scope} · updated: ${m.updated}\n\n${m.body}`);
    }
    case "memory_write": {
      const text = String(args?.text ?? "").trim();
      if (!text) return fail("text is required");
      if (text.length > 8000) return fail("Too long: save one fact per call.");
      const key = await repoKey(cwd);
      const scope = args?.scope === "global" ? "global" : args?.scope === "repo" ? `repo:${key}` : undefined;
      const type = MEMORY_TYPES.includes(args?.type) ? args.type : undefined;
      const note = {
        text,
        type,
        scope,
        repo: key,
        sessionId: process.env.TETHER_SESSION_ID,
        sessionKey: process.env.TETHER_SESSION_KEY,
        ts: Date.now(),
      };
      writeAtomic(join(store.dir, "inbox", `${Date.now()}-${sha(text + Math.random())}.json`), JSON.stringify(note));
      return ok("Saved. Tether merges it into the shared memory shortly (duplicates and contradictions are handled there).");
    }
    case "skill_list": {
      const skills = listSkills(join(store.dir, "skills"), readMeta(join(store.dir, "skills.json"))).filter((s) => s.enabled);
      if (!skills.length) return ok("The skill library is empty.");
      return ok(skills.map((s) => `- ${s.name}: ${s.description ?? ""}`).join("\n"));
    }
    case "skill_get": {
      const n = String(args?.name ?? "");
      const p = skillFile(join(store.dir, "skills"), n);
      if (!p) return fail(`No skill "${n}". Use skill_list.`);
      const dir = join(store.dir, "skills", n.replace(/-tether$/, ""));
      const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f !== "SKILL.md");
      return ok(`${readFileSync(p, "utf8")}${files.length ? `\n\n---\nSupporting files in ${dir}:\n${files.map((f) => `- ${f}`).join("\n")}` : ""}`);
    }
  }
  return fail(`Unknown tool ${name}`);
}

/** One JSON-RPC message in, at most one reply out. */
export async function handle(msg: any): Promise<object | undefined> {
  const id = msg?.id;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  switch (msg?.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "tether-context", version: "0.1.0" },
        instructions: "The user's shared memory and skills across coding agents (Tether). Search before assuming; write durable facts back.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call":
      try {
        return reply(await callTool(String(msg.params?.name), msg.params?.arguments ?? {}));
      } catch (e: any) {
        return reply(fail(`tether-context error: ${e?.message ?? e}`));
      }
  }
  if (id === undefined || id === null) return undefined; // notification
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${msg?.method}` } };
}

if (import.meta.main) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
        continue;
      }
      const out = await handle(msg);
      if (out) process.stdout.write(JSON.stringify(out) + "\n");
    }
  }
}
