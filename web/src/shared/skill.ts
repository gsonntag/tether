// Skill invocation from the message box: `/name args`. Shared by the runner (parsing, expansion)
// and the browser (the menu's filter, the transcript chip).
//
// When a harness can't run a skill itself, the runner sends the skill inline as a delimited block
// in the same shape pi uses for its own `/skill:name` (so both render as the same chip):
//
//   <skill name="NAME" location="/abs/SKILL.md">
//   …
//   </skill>
//
//   User request: ARGS

/** `/name args` → the skill to run; `\/name` → the text without the backslash, never a skill. */
export type Invocation = { name: string; args: string } | { literal: string };

const NAME = /^\/([A-Za-z0-9][\w.:-]*)(?:[ \t\n]+([\s\S]*))?$/;

export function parseInvocation(text: string): Invocation | undefined {
  if (text.startsWith("\\/")) return { literal: text.slice(1) };
  const m = NAME.exec(text);
  if (!m) return undefined;
  return { name: m[1]!, args: (m[2] ?? "").trim() };
}

/** A name `/name` can invoke. Anything else (quotes, spaces, `<`, …) is never offered or expanded. */
export const isSkillName = (name: string) => name.length <= 128 && /^[A-Za-z0-9][\w.:-]*$/.test(name);

export const invocationText = (name: string, args: string) => (args ? `/${name} ${args}` : `/${name}`);

export interface SkillBlockInput {
  name: string;
  /** absolute path of SKILL.md */
  location: string;
  /** SKILL.md without its front matter */
  body: string;
  /** absolute paths of the skill's other files */
  files: string[];
  args: string;
}

const REQUEST = "User request: ";

/** An attribute value that can't end the opening tag or its line (`"`, `<`, `>`, control chars → %xx). */
const attr = (v: string) => v.replace(/[\u0000-\u001f"<>%]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
/** Undoes attr() for display. */
const unattr = (v: string) => v.replace(/%([0-9a-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

/**
 * SKILL.md (or a file path) inside the block: a `</skill>` that would close it early, or a
 * `<skill …>` the transcript would show as a separate skill, is defused with a backslash.
 */
const inert = (v: string) => v.replace(/<(\/?)skill(?=[\s>])/gi, "<$1\\skill");
const oneLine = (v: string) => inert(v.replace(/[\r\n]+/g, " "));

/** The text an agent gets for a skill its harness can't run natively. */
export function skillBlock(s: SkillBlockInput): string {
  const dir = s.location.replace(/\/[^/]*$/, "");
  const lines = [
    `<skill name="${attr(s.name)}" location="${attr(s.location)}">`,
    `The user invoked the "${s.name}" skill. Follow its instructions below${s.args ? " for the request after this block" : ""}.`,
    `References are relative to ${oneLine(dir)}.`,
  ];
  if (s.files.length) {
    lines.push("Supporting files (read them with your tools when the instructions refer to them):");
    for (const f of s.files) lines.push(`- ${oneLine(f)}`);
  }
  lines.push("", inert(s.body.trim()), "</skill>");
  const block = lines.join("\n");
  return s.args ? `${block}\n\n${REQUEST}${s.args}` : block;
}

/** A skill block (ours or pi's) inside a user message, and the text around it. */
export interface SkillSegment {
  name: string;
  location: string;
  /** the whole block, for the expandable chip */
  content: string;
}

// Closed by `</skill>` on its own line, followed by a blank line or the end (as pi parses its own).
const BLOCK = /<skill name="([^"\n]+)" location="([^"\n]+)">\n[\s\S]*?\n<\/skill>(?=\n\n|\s*$)/g;

/** Splits a user message into text and skill blocks, in order. */
export function splitSkills(text: string): (string | SkillSegment)[] {
  const out: (string | SkillSegment)[] = [];
  let last = 0;
  for (const m of text.matchAll(BLOCK)) {
    const before = text.slice(last, m.index);
    if (before.trim()) out.push(before);
    out.push({ name: unattr(m[1]!), location: unattr(m[2]!), content: m[0] });
    last = m.index! + m[0].length;
    // The request that came with it reads as the user's own words.
    const rest = text.slice(last);
    const lead = /^\n\n(User request: )?/.exec(rest);
    if (lead) last += lead[0].length;
  }
  const rest = text.slice(last);
  if (rest.trim() || !out.length) out.push(rest);
  return out;
}

/** The message as the person typed it (`/name args`), for titles and the guard's judge. */
export function displayText(text: string): string {
  // pi's own syntax for a skill Tether passed to it natively
  if (text.startsWith("/skill:")) return "/" + text.slice(7);
  if (!text.includes("<skill name=")) return text;
  const out: string[] = [];
  const segs = splitSkills(text);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (typeof s === "string") out.push(s.trim());
    else if (typeof segs[i + 1] === "string") out.push(invocationText(s.name, (segs[++i] as string).trim()));
    else out.push(`/${s.name}`);
  }
  // A block cut short (a harness's own session name, say) still reads as the skill.
  return out
    .filter(Boolean)
    .join("\n\n")
    .replace(/<skill name="([^"\n]+)"[\s\S]*$/, "/$1");
}

// ---------- the composer's menu ----------

/**
 * Fuzzy match score of `query` against `name` (and, weaker, `description`): higher is better,
 * undefined when it doesn't match. Prefix > word start > substring > subsequence.
 */
export function fuzzyScore(query: string, name: string, description = ""): number | undefined {
  const q = query.toLowerCase();
  if (!q) return 0;
  const n = name.toLowerCase();
  if (n === q) return 1000;
  if (n.startsWith(q)) return 900 - n.length;
  const word = n.search(new RegExp(`(^|[-_:.])${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  if (word >= 0) return 700 - word;
  const sub = n.indexOf(q);
  if (sub >= 0) return 600 - sub;
  // Subsequence, initials-style: after the first letter, each one continues the previous match or
  // starts a word ("gm" → grill-me, "cr" → code-review), so scattered letters don't match.
  const wordStart = (j: number) => j === 0 || /[-_:. ]/.test(n[j - 1]!);
  let i = 0;
  let first = -1;
  let lastHit = -1;
  for (let j = 0; j < n.length && i < q.length; j++) {
    if (n[j] !== q[i]) continue;
    if (first >= 0 && j !== lastHit + 1 && !wordStart(j)) continue;
    if (first < 0) first = j;
    lastHit = j;
    i++;
  }
  if (i === q.length) return 400 - (lastHit - first) - first;
  if (description.toLowerCase().includes(q)) return 100;
  return undefined;
}

/** Entries matching `query`, best first (stable for equal scores). */
export function fuzzyFilter<T extends { name: string; description?: string }>(items: T[], query: string): T[] {
  return items
    .map((it, i) => ({ it, i, s: fuzzyScore(query, it.name, it.description) }))
    .filter((x) => x.s !== undefined)
    .sort((a, b) => b.s! - a.s! || a.i - b.i)
    .map((x) => x.it);
}
