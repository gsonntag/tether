// Moving a session to another harness (SPEC §15). Every harness exports to one neutral format and
// imports from it, so a new harness does each once and works with all the others; nothing here or
// in the module knows a pair of harnesses. Pure: the runner's module does the files and the sessions.
//
//  PortableSession   the whole session as transcript messages (shared/transcript.ts), with subagents
//  archiveMarkdown   all of it as one readable file: the history the agent can always go back to
//  planImport        what fits the target's context, as plain turns, and a digest of what doesn't
//
// Tool calls don't exist on another harness, so they travel as text: what ran and what it returned,
// never as a tool call with an id the target would have to honor.

import { FROM_TETHER } from "./fromTether";
import type { SourceChoices } from "./credentials";
import type { Billing, HarnessId, Msg, Part, ToolPart } from "./transcript";

export const PORTABLE_VERSION = 1;

/** A subagent's whole transcript, under the tool call that started it. */
export interface PortableSubagent {
  id: string;
  title: string;
  agentType?: string;
  parentToolId?: string;
  messages: Msg[];
  subagents: PortableSubagent[];
}

/** A whole session, whatever harness it ran on. */
export interface PortableSession {
  version: number;
  from: {
    sessionId: string;
    harness: HarnessId;
    harnessLabel: string;
    title: string;
    projectPath: string;
    model?: string;
    effort?: string;
    permissionMode?: string;
  };
  messages: Msg[];
  subagents: PortableSubagent[];
}

/** One turn of a conversation as a target takes it: text and images, in a role. */
export interface PortableItem {
  role: "user" | "assistant";
  text: string;
  images?: { mimeType: string; data: string }[];
  ts: number;
}

export interface ImportPlan {
  /** the turns, oldest first: Tether's opening message, then the history that fits */
  items: PortableItem[];
  /** messages of the session (subagents' not counted) */
  total: number;
  /** of those, how many are in `items` */
  kept: number;
  /** the estimate of what `items` costs, in tokens */
  tokens: number;
}

/**
 * How far a mode lets an agent go without asking, on one scale for every harness (SPEC §15). A
 * target's mode is the loosest one at or under the source's level; unknown is the lowest.
 */
export const LEVELS = {
  /** changes nothing */
  readOnly: 0,
  /** asks before edits and commands */
  ask: 1,
  /** edits go ahead in the folder; commands ask */
  edits: 2,
  /** edits and commands go ahead, held in the folder by a sandbox */
  sandboxed: 3,
  /** nothing confines it: the harness judges what needs asking */
  judged: 4,
  /** everything goes ahead */
  full: 5,
} as const;
export type Level = (typeof LEVELS)[keyof typeof LEVELS];

/** The target's mode for a source's: its loosest mode at or under the level (unknown: the lowest). */
export function mapMode(level: Level | undefined, targetModes: { mode: string; level: Level }[]): string {
  const sorted = [...targetModes].sort((a, b) => a.level - b.level);
  const lowest = sorted[0];
  if (!lowest) throw new Error("That harness has no permission modes.");
  if (level === undefined) return lowest.mode;
  return sorted.filter((m) => m.level <= level).at(-1)?.mode ?? lowest.mode;
}

// ---------- rendering ----------

const CHARS_PER_TOKEN = 4;
/** What one image is counted as: a large image costs about this much on every harness we know. */
const IMAGE_TOKENS = 2_000;
/** One tool's input or output in context; the whole of it is in the archive. */
export const TOOL_TEXT_MAX = 12_000;
/** Images sent as images: more of them fail on some APIs. The rest stay as files. */
export const INLINE_IMAGES_MAX = 16;
/** An image larger than this (base64) stays a file: providers refuse them. */
export const INLINE_IMAGE_MAX = 3_500_000;
/** What's kept of the target's window for the work ahead. */
export const CONTEXT_SHARE = 0.5;
/** Whatever the window: every later turn resends this much. */
export const BUDGET_MAX = 200_000;
/** The window isn't known. */
export const BUDGET_UNKNOWN = 80_000;

export const budgetFor = (window: number | undefined) => Math.min(BUDGET_MAX, window ? Math.floor(window * CONTEXT_SHARE) : BUDGET_UNKNOWN);

export const estimateTokens = (chars: number, images = 0) => Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS;

const fence = (text: string, lang = "") => {
  const ticks = "`".repeat(Math.max(3, ...[...text.matchAll(/`{3,}/g)].map((m) => m[0].length + 1)));
  return `${ticks}${lang}\n${text}\n${ticks}`;
};

const cut = (text: string, max: number, whole: string) =>
  text.length <= max ? text : `${text.slice(0, max)}\n… ${text.length - max} more characters in ${whole}`;

const inputText = (t: ToolPart) => {
  if (t.command) return t.command;
  if (typeof t.input === "string") return t.input;
  try {
    return JSON.stringify(t.input, null, 2) ?? "";
  } catch {
    return String(t.input);
  }
};

/** A tool call as text: readable history, and no id for the target to honor. */
export function renderTool(t: ToolPart, max = Infinity, whole = "the history file"): string {
  const status = t.status === "error" ? "failed" : t.status === "running" ? "didn't finish" : "done";
  const out = [`**Tool: ${t.name}**${t.path ? ` \`${t.path}\`` : ""} (${status})`];
  const input = inputText(t);
  if (input && input !== "{}") out.push(fence(cut(input, max, whole), t.kind === "shell" ? "sh" : ""));
  if (t.output) out.push(`Output:\n${fence(cut(t.output, max, whole))}`);
  return out.join("\n");
}

/** A message's images, named as the archive keeps them. */
export const imageName = (msgId: string, n: number, mimeType: string) => `${msgId.replace(/[^\w-]/g, "_").slice(0, 60)}-${n}.${mimeType.split("/")[1]?.replace(/[^\w]/g, "") || "bin"}`;

function renderParts(m: Msg, o: { max: number; whole: string; imagesDir?: string; subagents?: PortableSubagent[] }): string {
  const lines: string[] = [];
  let image = 0;
  for (const p of m.parts as Part[]) {
    if (p.type === "text") lines.push(p.text);
    else if (p.type === "thinking") {
      if (p.text) lines.push(`*Thinking:* ${cut(p.text, o.max, o.whole)}`);
    } else if (p.type === "image") {
      const name = imageName(m.id, image++, p.mimeType);
      lines.push(o.imagesDir ? `[image: ${o.imagesDir}/${name}]` : `[image: ${name}]`);
    } else lines.push(renderTool(p, o.max, o.whole));
  }
  return lines.join("\n\n");
}

const originOf = (m: Msg) => (m.origin ? `From ${m.origin.name ?? m.origin.kind}: ` : "");

function when(ts: number) {
  return ts > 0 ? new Date(ts).toISOString() : "";
}

function renderSubagent(a: PortableSubagent, depth: number, out: string[], imagesDir?: string) {
  const h = "#".repeat(Math.min(depth, 6));
  out.push(`${h} Subagent: ${a.title}${a.agentType ? ` (${a.agentType})` : ""}${a.parentToolId ? `, started by tool call ${a.parentToolId}` : ""}`);
  for (const m of a.messages) renderMessage(m, depth + 1, out, imagesDir);
  for (const c of a.subagents) renderSubagent(c, depth + 1, out, imagesDir);
}

function renderMessage(m: Msg, depth: number, out: string[], imagesDir?: string) {
  const h = "#".repeat(Math.min(depth, 6));
  if (m.role === "notice") {
    const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    if (m.compactSummary) out.push(`${h} Compaction summary ${when(m.ts)}`, m.compactSummary);
    else if (text) out.push(`*${text}*`);
    return;
  }
  const role = m.role === "user" ? "User" : `Assistant${m.model ? ` (${m.model})` : ""}`;
  out.push(`${h} ${role} ${when(m.ts)}`.trimEnd());
  const body = renderParts(m, { max: Infinity, whole: "", imagesDir });
  if (body) out.push(originOf(m) + body);
  if (m.error) out.push(`Error: ${m.error}`);
}

/** The whole session as one readable file; images are named under `imagesDir`. */
export function archiveMarkdown(s: PortableSession, imagesDir = "images"): string {
  const out: string[] = [
    `# ${s.from.title}`,
    `Moved from ${s.from.harnessLabel}, session ${s.from.sessionId}. Folder ${s.from.projectPath}.${s.from.model ? ` Model ${s.from.model}.` : ""}`,
    "Tools below ran on that harness and are history.",
  ];
  for (const m of s.messages) renderMessage(m, 2, out, imagesDir);
  for (const a of s.subagents) renderSubagent(a, 2, out, imagesDir);
  return `${out.join("\n\n")}\n`;
}

const firstLine = (text: string, n: number) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const textOf = (m: Msg) => m.parts.map((p) => (p.type === "text" ? p.text : "")).filter(Boolean).join("\n");

const PROMPTS_MAX = 150;
const FILES_MAX = 60;
const SUMMARY_MAX = 8_000;

/** What's in messages left out of context: no model is asked, so it says only what's there. */
export function digest(msgs: Msg[], subagents: PortableSubagent[] = []): string {
  const prompts = msgs.filter((m) => m.role === "user" && !m.origin && textOf(m).trim()).map((m) => firstLine(textOf(m), 140));
  const files = new Set<string>();
  const commands: string[] = [];
  for (const m of msgs)
    for (const p of m.parts)
      if (p.type === "tool") {
        if ((p.kind === "edit" || p.kind === "write") && p.path) files.add(p.path);
        if (p.kind === "shell" && p.command) commands.push(firstLine(p.command, 80));
      }
  const summary = [...msgs].reverse().find((m) => m.compactSummary)?.compactSummary;
  const shown = prompts.length > PROMPTS_MAX ? [...prompts.slice(0, PROMPTS_MAX / 2), `… ${prompts.length - PROMPTS_MAX} more …`, ...prompts.slice(-PROMPTS_MAX / 2)] : prompts;
  const out: string[] = [];
  if (summary) out.push(`The last compaction's summary:\n${cut(summary, SUMMARY_MAX, "the history file")}`);
  if (shown.length) out.push(`What the user asked, in order:\n${shown.map((p) => `- ${p}`).join("\n")}`);
  if (files.size) out.push(`Files changed: ${[...files].slice(0, FILES_MAX).join(", ")}${files.size > FILES_MAX ? ` and ${files.size - FILES_MAX} more` : ""}.`);
  if (commands.length) out.push(`${commands.length} commands ran; the last: ${commands.slice(-5).map((c) => `\`${c}\``).join(", ")}.`);
  if (subagents.length) out.push(`Subagents: ${subagents.map((a) => a.title).join(", ")}. Their whole work is in the file.`);
  return out.join("\n\n");
}

export interface OpeningFacts {
  /** where the whole history is */
  file: string;
  imagesDir: string;
  total: number;
  kept: number;
  background?: boolean;
  /** the last reply, when nothing of the conversation is in context */
  lastReply?: string;
  /** what's left out */
  digest?: string;
}

/** Tether's first message on the target: where this came from and where the rest is. */
export function openingText(s: PortableSession, f: OpeningFacts): string {
  const lines = [
    `${FROM_TETHER}This session moved here from ${s.from.harnessLabel} ("${s.from.title}"), in ${s.from.projectPath}. The person chose to move it.`,
    `Tool calls in the history ran on ${s.from.harnessLabel} and are shown as text. They're past events: your own tools are the ones you have now.`,
    `The whole history is in ${f.file}, images in ${f.imagesDir}, subagents' work included. Read it when you need more than is here; it can be long, so search it or read it in parts.`,
  ];
  if (f.background) lines.push(`Background work keeps running in the old session on ${s.from.harnessLabel}. It didn't move, and you can't see it.`);
  if (f.kept < f.total) lines.push(f.kept ? `The newest ${f.kept} of ${f.total} messages follow; the rest are only in that file.` : `None of the ${f.total} messages are in this conversation; they're in that file.`);
  if (f.digest) lines.push(f.digest);
  if (f.lastReply) lines.push(`The last reply there was:\n${f.lastReply}`);
  return lines.join("\n\n");
}

/** A message as a turn for context; undefined when nothing of it goes to a model. */
function itemOf(m: Msg, images: number, o: { whole: string; subagents: PortableSubagent[] }): { item: PortableItem; images: number } | undefined {
  if (m.role === "notice") {
    if (!m.compactSummary) return undefined;
    return { item: { role: "assistant", text: `*Compaction summary:*\n\n${m.compactSummary}`, ts: m.ts }, images };
  }
  const parts: string[] = [];
  const kept: { mimeType: string; data: string }[] = [];
  let n = 0;
  for (const p of m.parts) {
    if (p.type === "text") parts.push(p.text);
    else if (p.type === "thinking") {
      if (p.text) parts.push(`*Thinking:* ${cut(p.text, TOOL_TEXT_MAX, o.whole)}`);
    } else if (p.type === "image") {
      const name = imageName(m.id, n++, p.mimeType);
      // Only a user's: an assistant turn takes no images on any harness.
      if (m.role === "user" && images + kept.length < INLINE_IMAGES_MAX && p.data.length <= INLINE_IMAGE_MAX) kept.push({ mimeType: p.mimeType, data: p.data });
      else parts.push(`[image: ${name}, in the history's images folder]`);
    } else {
      parts.push(renderTool(p, TOOL_TEXT_MAX, o.whole));
      // A subagent's work sits under the call that started it: its report is the call's output.
      const a = o.subagents.find((x) => x.parentToolId === p.id);
      if (a) parts.push(`(Subagent "${a.title}": ${a.messages.length} messages, all in ${o.whole}.)`);
    }
  }
  const text = originOf(m) + parts.filter(Boolean).join("\n\n") + (m.error ? `\n\nError: ${m.error}` : "");
  if (!text.trim() && !kept.length) return undefined;
  return { item: { role: m.role === "user" ? "user" : "assistant", text, ...(kept.length ? { images: kept } : {}), ts: m.ts }, images: images + kept.length };
}

const itemTokens = (i: PortableItem) => estimateTokens(i.text.length, i.images?.length ?? 0);

/**
 * What goes into the target's context: the newest messages that fit `budget`, in order, after
 * Tether's opening. A history that doesn't fit is said to the agent, with a digest of the rest; the
 * whole of it is in the archive either way. Images are counted from the newest back.
 */
export function planImport(s: PortableSession, budget: number, facts: Pick<OpeningFacts, "file" | "imagesDir" | "background">): ImportPlan {
  const o = { whole: facts.file, subagents: s.subagents };
  const shown = s.messages.filter((m) => m.role !== "notice");
  // A worst-case opening (digest of everything) is held out of the budget.
  const roomFor = (text: string) => budget - estimateTokens(text.length);
  const full = openingText(s, { ...facts, total: shown.length, kept: 0, digest: digest(s.messages, s.subagents) });
  const room = roomFor(full);
  const picked: PortableItem[] = [];
  let used = 0;
  let images = 0;
  let oldest = s.messages.length;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i]!;
    const r = itemOf(m, images, o);
    if (!r) {
      oldest = i;
      continue;
    }
    const cost = itemTokens(r.item);
    if (used + cost > room) break;
    used += cost;
    images = r.images;
    picked.unshift(r.item);
    oldest = i;
  }
  const left = s.messages.slice(0, oldest);
  const kept = shown.length - left.filter((m) => m.role !== "notice").length;
  const opening = openingText(s, { ...facts, total: shown.length, kept, ...(kept < shown.length ? { digest: digest(left, s.subagents) } : {}) });
  const items: PortableItem[] = [{ role: "user", text: opening, ts: s.messages[oldest]?.ts ?? 0 }, ...picked];
  // Every target reads a conversation that ends with the agent: a turn cut off leaves it with the user.
  if (picked.at(-1)?.role !== "assistant") items.push({ role: "assistant", text: "Moved. Nothing was run here yet.", ts: picked.at(-1)?.ts ?? 0 });
  return { items, total: shown.length, kept, tokens: items.reduce((t, i) => t + itemTokens(i), 0) };
}

/** The opening a target with no native import gets as its first turn: everything is in the file. */
export function contextOpening(s: PortableSession, facts: Pick<OpeningFacts, "file" | "imagesDir" | "background">): string {
  const last = [...s.messages].reverse().find((m) => m.role === "assistant" && textOf(m).trim());
  const shown = s.messages.filter((m) => m.role !== "notice").length;
  return `${openingText(s, { ...facts, total: shown, kept: 0, digest: digest(s.messages, s.subagents), ...(last ? { lastReply: cut(textOf(last), 4_000, "the history file") } : {}) })}\n\nDon't run anything yet. Reply "Ready." and wait for the person.`;
}

/** What the new session and the old one say about a move. */
export const movedFrom = (label: string) => `Moved from ${label}.`;
export const movedTo = (label: string) => `Moved to ${label}.`;

/** The target session's line on what fit, when not all of it did. */
export const contextNote = (kept: number, total: number) => (kept >= total ? undefined : kept ? `${kept} of ${total} messages in context; the agent can read the rest.` : `${total} messages in a file the agent can read.`);

/** What the dialog shows for a target. */
export interface MoveTarget {
  harness: HarnessId;
  label: string;
  /** "native": the harness takes the history itself; "context": a file and a summary */
  route: "native" | "context";
  /** the mode the session would start in there */
  permissionMode: string;
  /** a runner from before per-session sources: what the new session would draw from */
  billing?: Billing;
  /** the sources it can go to; the session's own harness offers only sources other than its own */
  sources?: SourceChoices;
  /** the session's own harness: the move changes only the source */
  sameHarness?: boolean;
  /** the source fixes the model (an Azure deployment) */
  deployment?: string;
}

export interface MoveOptions {
  targets: MoveTarget[];
  /** why it can't move now */
  blocked?: string;
  /** work that keeps running in this session and doesn't move */
  background?: boolean;
}

export const movedHistoryStart = `${FROM_TETHER}This session moved here from `;
