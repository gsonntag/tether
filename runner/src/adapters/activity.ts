// Helpers the adapters share to build activity items (web/src/shared/protocol.ts ActivityItem).

import { ACTIVITY_MAX_STEPS, type ActivityItem, type ActivityStep, type ToolStatus } from "../../../web/src/shared/protocol";

const base = (p: unknown) => (typeof p === "string" ? p.split(/[\\/]/).filter(Boolean).pop() ?? p : "");
const clip = (s: string, n = 80) => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > n ? line.slice(0, n - 1) + "…" : line;
};

/** A one-line, present-tense summary of a tool call: "Editing Sidebar.tsx", "Running bun test". */
export function describeTool(name: string, input: any): string {
  const i = input && typeof input === "object" ? input : {};
  const file = i.file_path ?? i.path ?? i.notebook_path ?? i.filePath;
  const n = name.toLowerCase();
  if (n === "read" || n === "read_file") return file ? `Reading ${base(file)}` : "Reading";
  if (n === "edit" || n === "multiedit" || n === "str_replace" || n === "notebookedit" || n === "apply_patch") return file ? `Editing ${base(file)}` : "Editing";
  if (n === "write" || n === "write_file" || n === "create") return file ? `Writing ${base(file)}` : "Writing";
  if (n === "bash" || n === "shell" || n === "exec_command" || n === "commandexecution") {
    const cmd = Array.isArray(i.command) ? i.command.join(" ") : i.command ?? i.cmd;
    return typeof cmd === "string" && cmd ? `Running ${clip(cmd, 70)}` : "Running a command";
  }
  if (n === "grep" || n === "search") return i.pattern ? `Searching for ${clip(String(i.pattern), 50)}` : "Searching";
  if (n === "glob" || n === "find" || n === "ls") return i.pattern ? `Finding ${clip(String(i.pattern), 50)}` : "Listing files";
  if (n === "webfetch" || n === "fetch") {
    try {
      return `Fetching ${new URL(i.url).host}`;
    } catch {
      return "Fetching a page";
    }
  }
  if (n === "websearch" || n === "web_search") return i.query ? `Searching the web for ${clip(String(i.query), 50)}` : "Searching the web";
  if (n === "agent" || n === "task" || n === "subagent") return `Starting agent${i.description ? `: ${clip(String(i.description), 60)}` : ""}`;
  if (n === "todowrite" || n === "update_plan") return "Updating the todo list";
  if (n === "toolsearch") return "Loading tools";
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return `${mcp[1]}: ${mcp[2]}`;
  return name;
}

/** The last `lines` lines of some output, capped in size. */
export function tail(text: string, lines = 15, max = 2_000): string {
  const t = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const out = t.split("\n").slice(-lines).join("\n");
  return out.length > max ? "…" + out.slice(-max) : out;
}

/**
 * Keeps activity items immutably: every change makes a new object, so items handed to the session
 * (and its transcript state) never change behind its back. Collects what changed since `take()`.
 */
export class ActivityBook {
  private items = new Map<string, ActivityItem>();
  private changed = new Map<string, ActivityItem>();

  constructor(protected now: () => number = Date.now) {}

  get(id: string | undefined): ActivityItem | undefined {
    return id ? this.items.get(id) : undefined;
  }

  list(): ActivityItem[] {
    return [...this.items.values()];
  }

  /** Adds an item, or patches an existing one. */
  put(item: ActivityItem): ActivityItem {
    this.items.set(item.id, item);
    this.changed.set(item.id, item);
    return item;
  }

  patch(id: string | undefined, p: Partial<ActivityItem>): ActivityItem | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    // An item that already ended stays ended (a late progress frame can't revive it).
    if (cur.endedAt && p.status && (p.status === "running" || p.status === "waiting")) delete p.status;
    return this.put({ ...cur, ...p });
  }

  /** Ends an item (once): status, end time, and anything else known at the end. */
  end(id: string | undefined, status: "done" | "failed" | "stopped", p: Partial<ActivityItem> = {}): ActivityItem | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    if (cur.endedAt) return Object.keys(p).length ? this.put({ ...cur, ...p }) : cur;
    return this.put({ ...cur, ...p, status, endedAt: p.endedAt ?? this.now() });
  }

  /** One step of a subagent's mini-transcript; it also becomes the item's latest action. */
  step(id: string | undefined, step: Omit<ActivityStep, "ts">, opts: { count?: boolean } = {}) {
    const cur = this.get(id);
    if (!cur) return;
    // Harnesses that report the count themselves pass count: false.
    const known = opts.count === false || cur.steps?.some((s) => s.id === step.id);
    const steps = [...(cur.steps ?? []).filter((s) => s.id !== step.id), { ...step, ts: this.now() }].slice(-ACTIVITY_MAX_STEPS);
    this.put({ ...cur, steps, latest: step.label, toolUses: (cur.toolUses ?? 0) + (known ? 0 : 1) });
  }

  stepDone(id: string | undefined, stepId: string, status: ToolStatus) {
    const cur = this.get(id);
    if (!cur?.steps?.some((s) => s.id === stepId)) return;
    this.put({ ...cur, steps: cur.steps.map((s) => (s.id === stepId ? { ...s, status } : s)) });
  }

  /** What changed since the last call. */
  take(): ActivityItem[] {
    const out = [...this.changed.values()];
    this.changed.clear();
    return out;
  }
}
