// MCP elicitations (a server asking the user for input mid-call) as Tether UI questions. The form
// schema is MCP's restricted one (2025-11-25 `ElicitRequestFormParams.requestedSchema`): a flat
// object of string / number / boolean / enum properties. Each property becomes one question;
// enums and booleans get their options, free text goes through the question card's "Other" box.
// Optional fields get a "Skip" option, since the card wants an answer to every question.

import type { UiRequest, UiResponse } from "../../../web/src/shared/protocol";
import { newId } from "../session";

export const SKIP = "Skip";

type Field = {
  key: string;
  question: string;
  type: "string" | "number" | "integer" | "boolean" | "array";
  required: boolean;
  /** option label → value sent back */
  values?: Map<string, string>;
};

/** label/value pairs of an enum property (untitled `enum`, legacy `enumNames`, titled `oneOf`/`anyOf`). */
function enumOptions(p: any): Map<string, string> | undefined {
  const titled = p?.oneOf ?? p?.anyOf;
  if (Array.isArray(titled)) return new Map(titled.filter((o: any) => typeof o?.const === "string").map((o: any) => [String(o.title ?? o.const), o.const]));
  if (Array.isArray(p?.enum)) return new Map(p.enum.map((v: any, i: number) => [String(p.enumNames?.[i] ?? v), String(v)]));
  return undefined;
}

function fields(schema: any): Field[] {
  const props = schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = new Set<string>(Array.isArray(schema?.required) ? schema.required : []);
  const seen = new Set<string>();
  const out: Field[] = [];
  for (const [key, p] of Object.entries<any>(props)) {
    if (!p || typeof p !== "object") continue;
    const label = String(p.title ?? key);
    let question = p.description ? `${label}: ${p.description}` : label;
    if (seen.has(question)) question = `${question} (${key})`;
    seen.add(question);
    const type = p.type === "array" ? "array" : p.type === "boolean" ? "boolean" : p.type === "number" || p.type === "integer" ? p.type : "string";
    out.push({ key, question, type, required: required.has(key), values: type === "array" ? enumOptions(p.items) : type === "string" ? enumOptions(p) : undefined });
  }
  return out;
}

/** The question card for a form elicitation; undefined when the schema has nothing to ask. */
export function formRequest(title: string, schema: unknown): UiRequest | undefined {
  const fs = fields(schema);
  if (!fs.length) return undefined;
  return {
    id: newId("q"),
    kind: "question",
    title,
    questions: fs.map((f) => {
      const options = f.type === "boolean" ? ["Yes", "No"] : [...(f.values?.keys() ?? [])];
      if (!f.required) options.push(SKIP);
      return { question: f.question, options: options.map((label) => ({ label })), multiSelect: f.type === "array" || undefined };
    }),
  };
}

/** The answers as the form's `content`: typed values, skipped fields left out. */
export function formContent(schema: unknown, r: UiResponse): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields(schema)) {
    const a = r.answers?.[f.question];
    if (a === undefined || (a === SKIP && !f.required)) continue;
    const pick = (label: string) => f.values?.get(label) ?? label;
    if (f.type === "array") out[f.key] = a.split(", ").filter((x) => x && x !== SKIP).map(pick);
    else if (f.type === "boolean") out[f.key] = /^(yes|true|y|1)$/i.test(a.trim());
    else if (f.type === "number" || f.type === "integer") {
      const n = Number(a.trim());
      if (a.trim() && Number.isFinite(n)) out[f.key] = f.type === "integer" ? Math.trunc(n) : n;
    } else out[f.key] = pick(a);
  }
  return out;
}
