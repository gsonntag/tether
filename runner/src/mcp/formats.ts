// MCP server entries in each harness's own config format, both ways. Every harness spells the same
// server a little differently (verified against each CLI's own `mcp add`, run in a scratch HOME):
//   claude    ~/.claude.json, .mcp.json  {type:"stdio", command, args, env} | {type:"http"|"sse", url, headers}
//   plain     pi mcp.json / mcp-adapter.json, Kiro  {command, args, env} | {url, headers}
//   opencode  `mcp`  {type:"local", command:[cmd, ...args], environment} | {type:"remote", url, headers}
//   agy       Antigravity mcp_config.json  {command, args, env} | {serverUrl, headers}
//   gemini    ~/.gemini/settings.json  {command, args, env} | {httpUrl, headers} (http) | {url, headers} (sse)
//   codex     config.toml [mcp_servers.x]  command/args/env/cwd | url/http_headers (no SSE)

import { basename } from "node:path";
import type { McpTransport } from "../../../web/src/shared/protocol";

export type Flavor = "claude" | "plain" | "opencode" | "agy" | "gemini" | "codex";

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string" || typeof x === "number").map(String) : []);

/** A string → string map (numbers and booleans as text); anything else is dropped. */
function stringMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") out[k] = String(x);
  return out;
}

export interface ParsedEntry {
  transport: McpTransport;
  enabled: boolean;
}

/** One server entry from a harness config; undefined when it isn't a server Tether can run. */
export function fromEntry(v: any, flavor: Flavor): ParsedEntry | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const enabled = v.disabled !== true && v.enabled !== false;
  const type = typeof v.type === "string" ? v.type.toLowerCase() : undefined;
  // A URL server.
  const url = [v.httpUrl, v.serverUrl, v.url].find((u) => typeof u === "string" && /^https?:\/\//i.test(u.trim()));
  if (url) {
    let t: "http" | "sse" = "http";
    if (type === "sse") t = "sse";
    else if (flavor === "gemini" && typeof v.url === "string" && v.url === url && !v.httpUrl) t = "sse"; // gemini: url is SSE, httpUrl streamable
    else if (!type && flavor !== "gemini" && /\/sse\/?$/.test(url)) t = "sse";
    return { transport: { type: t, url: url.trim(), headers: stringMap(v.headers ?? v.http_headers) }, enabled };
  }
  // A command (opencode: one array).
  let command: string | undefined;
  let args: string[];
  if (Array.isArray(v.command)) {
    const parts = strings(v.command);
    command = parts[0];
    args = [...parts.slice(1), ...strings(v.args)];
  } else {
    command = typeof v.command === "string" ? v.command : undefined;
    args = strings(v.args);
  }
  if (!command?.trim()) return undefined;
  const t: McpTransport = { type: "stdio", command: command.trim(), args, env: stringMap(v.env ?? v.environment) };
  if (typeof v.cwd === "string" && v.cwd) t.cwd = v.cwd;
  return { transport: t, enabled };
}

const nonEmpty = (m: Record<string, string>) => (Object.keys(m).length ? m : undefined);

/** Drops undefined fields, so written entries look like the harness's own. */
function clean<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/**
 * A stdio server with a working directory, for harnesses whose entries can't set one (all but
 * Codex; the Claude SDK and ACP v1 have no `cwd` either): `sh -c 'cd "$0" && exec "$@"' <cwd> <cmd> <args…>`.
 */
export function cwdless(t: McpTransport): McpTransport {
  if (t.type !== "stdio" || !t.cwd) return t;
  return { type: "stdio", command: "sh", args: ["-c", 'cd "$0" && exec "$@"', t.cwd, t.command, ...t.args], env: t.env };
}

/** The entry a harness config holds for this server; undefined when the harness can't take it. */
export function toEntry(t: McpTransport, flavor: Flavor): Record<string, unknown> | undefined {
  if (t.type === "stdio" && flavor !== "codex") t = cwdless(t);
  if (t.type === "stdio") {
    const env = nonEmpty(t.env);
    switch (flavor) {
      case "claude":
        return clean({ type: "stdio", command: t.command, args: t.args, env });
      case "opencode":
        return clean({ type: "local", command: [t.command, ...t.args], environment: env, enabled: true });
      case "codex":
        return clean({ command: t.command, args: t.args, env, cwd: t.cwd });
      default:
        return clean({ command: t.command, args: t.args, env });
    }
  }
  const headers = nonEmpty(t.headers);
  switch (flavor) {
    case "claude":
      return clean({ type: t.type, url: t.url, headers });
    case "opencode":
      return clean({ type: "remote", url: t.url, headers, enabled: true });
    case "agy":
      return clean({ serverUrl: t.url, headers });
    case "gemini":
      return t.type === "sse" ? clean({ url: t.url, headers }) : clean({ httpUrl: t.url, headers });
    case "codex":
      return t.type === "sse" ? undefined : clean({ url: t.url, http_headers: headers });
    default:
      return clean({ url: t.url, headers });
  }
}

// ---------------- identity ----------------

const RUNNERS = /^(npx|bunx|pnpx|uvx)$/;

/** `https://Example.com:443/mcp/` → `https://example.com/mcp`. */
export function normalizeUrl(u: string): string {
  try {
    const x = new URL(u.trim());
    const path = x.pathname.replace(/\/+$/, "");
    return `${x.protocol}//${x.host.toLowerCase()}${path}${x.search}`;
  } catch {
    return u.trim().replace(/\/+$/, "").toLowerCase();
  }
}

/**
 * Two entries are the same server when they run the same command line (the program's name, not
 * its path; `npx -y` the same as `npx`) or reach the same URL (http and SSE alike).
 */
export function identity(t: McpTransport): string {
  if (t.type !== "stdio") return `url:${normalizeUrl(t.url)}`;
  const cmd = basename(t.command.trim());
  const args = RUNNERS.test(cmd) ? t.args.filter((a) => a !== "-y" && a !== "--yes") : t.args;
  return `stdio:${[cmd, ...args].join("\u0000")}`;
}

/** The command line or URL, for display. */
export function summary(t: McpTransport): string {
  if (t.type !== "stdio") return t.url;
  return [t.command, ...t.args].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

/** A name every harness accepts as a server key (and a TOML bare key). */
export function cleanName(name: string): string {
  return (
    name
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "server"
  );
}

/** A name for a server pasted without one: the package (`@scope/server-github` → github), the host, or the program. */
export function deriveName(t: McpTransport): string {
  if (t.type !== "stdio") {
    try {
      const host = new URL(t.url).hostname.replace(/^(www|mcp|api)\./, "");
      return cleanName(host.split(".").slice(0, -1).join("-") || host);
    } catch {
      return "server";
    }
  }
  const cmd = basename(t.command);
  const pkg = RUNNERS.test(cmd) || cmd === "docker" ? [...t.args].reverse().find((a) => !a.startsWith("-") && !/^(run|exec|dlx)$/.test(a)) : undefined;
  const base = (pkg ?? cmd)
    .replace(/@[\w.^~-]+$/, "") // version
    .split("/")
    .pop()!
    .replace(/:[\w.-]+$/, "") // docker tag
    .replace(/^(mcp-server-|server-)|(-mcp-server|-mcp|-server)$/g, "")
    .replace(/^mcp-/, "");
  return cleanName(base || cmd);
}

// ---------------- TOML (codex) ----------------

const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
const tomlValue = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(tomlValue).join(", ")}]`
    : v && typeof v === "object"
      ? `{ ${Object.entries(v)
          .map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`)
          .join(", ")} }`
      : typeof v === "boolean" || typeof v === "number"
        ? String(v)
        : JSON.stringify(String(v));

/** `[mcp_servers.<name>]` tables for Codex's config.toml. */
export function codexToml(entries: [name: string, entry: Record<string, unknown>][]): string {
  return entries
    .map(([name, e]) => [`[mcp_servers.${tomlKey(name)}]`, ...Object.entries(e).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`)].join("\n"))
    .join("\n\n");
}

// ---------------- pasted text ----------------

/** Shell-like split: quotes group, backslash escapes. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|((?:[^\s"'\\]|\\.)+)/g)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3]!.replace(/\\(.)/g, "$1")));
  return out;
}

export interface Pasted {
  name: string;
  transport: McpTransport;
  enabled: boolean;
}

const looksLikeEntry = (v: any) => v && typeof v === "object" && !Array.isArray(v) && ["command", "url", "serverUrl", "httpUrl"].some((k) => k in v);

/**
 * Servers from what the user pasted: a URL, a command line (`FOO=1 npx -y pkg`), or JSON in any
 * harness's shape: `{"mcpServers": {...}}`, `{"mcp": {...}}` (opencode), `{"name": {...}}`, or one
 * server's object (named `name`, else derived).
 */
export function parsePaste(text: string, name?: string): Pasted[] {
  const s = text.trim();
  if (!s) throw new Error("Paste a command, a URL or a JSON snippet");
  if (s.startsWith("{")) {
    let v: any;
    try {
      v = Bun.JSONC.parse(s);
    } catch {
      throw new Error("That JSON couldn't be read");
    }
    const flavorOf = (e: any): Flavor => (e && typeof e === "object" && (e.type === "local" || e.type === "remote") ? "opencode" : "claude");
    if (looksLikeEntry(v)) {
      const p = fromEntry(v, flavorOf(v));
      if (!p) throw new Error("That server has no command or URL");
      return [{ name: cleanName(name || deriveName(p.transport)), ...p }];
    }
    const group = v.mcpServers ?? v.mcp_servers ?? v.servers ?? v.mcp ?? v;
    const out: Pasted[] = [];
    for (const [n, e] of Object.entries(group ?? {})) {
      const p = fromEntry(e, flavorOf(e));
      if (p) out.push({ name: cleanName(n), ...p });
    }
    if (!out.length) throw new Error("No MCP servers in that JSON");
    return out;
  }
  if (/^https?:\/\//i.test(s)) {
    if (/\s/.test(s)) throw new Error("A URL can't have spaces");
    const transport: McpTransport = { type: /\/sse\/?$/.test(s) ? "sse" : "http", url: s, headers: {} };
    return [{ name: cleanName(name || deriveName(transport)), transport, enabled: true }];
  }
  const parts = splitCommand(s);
  const env: Record<string, string> = {};
  while (parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0]!)) {
    const a = parts.shift()!;
    env[a.slice(0, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
  }
  if (!parts.length) throw new Error("No command to run");
  const transport: McpTransport = { type: "stdio", command: parts[0]!, args: parts.slice(1), env };
  return [{ name: cleanName(name || deriveName(transport)), transport, enabled: true }];
}
