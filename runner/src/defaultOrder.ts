// The user's default order: one ordered list of "harness:model" entries (the chain format, see
// ChainEntry in protocol.ts) that replaced named model profiles. A new session started on it runs
// on its first available entry and gets a copy as its own chain; so does a cross-harness subagent
// started without a harness or model. Editing it changes sessions started afterwards, never
// running ones (each has its own copy).

import { cleanOrder, entryProblem } from "../../web/src/shared/defaultOrder";
import { parseEntry, type HarnessId, type ModelRef } from "../../web/src/shared/protocol";
import { config, saveConfig } from "./config";
import { entryAvailable } from "./credentials/registry";
import { exhaustedUntil, isInstalled, quotaKey } from "./fallback";

/** The saved default order (a copy), or undefined while none is saved. */
export function defaultOrder(): string[] | undefined {
  const o = config().defaultOrder;
  return o?.length ? [...o] : undefined;
}

/**
 * Saves it (trimmed, no repeats); an empty one clears it. A bad entry refuses the whole save, and
 * so does a "#credential" not in `credentials` (the runner's ids, credentials/registry.ts) when given.
 */
export function saveDefaultOrder(order: unknown, credentials?: ReadonlySet<string>): string[] | undefined {
  if (!Array.isArray(order) || order.some((e) => typeof e !== "string")) throw new Error('The default order is a list of "harness:model" entries.');
  const clean = cleanOrder(order);
  const bad = clean.map((e) => entryProblem(e, credentials)).find(Boolean);
  if (bad) throw new Error(`${bad}. Nothing was saved.`);
  const cfg = config();
  if (clean.length) cfg.defaultOrder = clean;
  else delete cfg.defaultOrder;
  saveConfig();
  return defaultOrder();
}

export interface SessionStart {
  harness: HarnessId;
  model?: string;
  /** the credential its first entry runs on */
  credential?: string;
  /** the session's own chain: a copy of the default order */
  chain?: string[];
}

/**
 * Where a new session starts. On the default order (`useOrder`, and one is saved): its first entry
 * on an installed harness whose quota isn't known to be out (else the first installed one), with
 * the whole order as the session's chain. Otherwise, or when no entry's harness is installed, the
 * harness and model asked for, without a chain.
 */
export function sessionStart(
  want: { harness: HarnessId; model?: string; useOrder?: boolean },
  order: string[] | undefined,
  installed: (h: HarnessId) => boolean = isInstalled,
): SessionStart {
  // A picked model may name its credential ("gpt-6-luna#azure:east").
  const picked = want.model ? parseEntry(want.model, want.harness) : undefined;
  const plain = { harness: want.harness, ...(picked?.model ? { model: picked.model } : {}), ...(picked?.credential ? { credential: picked.credential } : {}) };
  if (!want.useOrder || !order?.length) return plain;
  // Entries on a harness that isn't installed, or a credential that is gone, are passed over.
  const entries = order.map((e) => parseEntry(e, want.harness)).filter((e) => installed(e.harness) && entryAvailable(e));
  const e = entries.find((x) => !exhaustedUntil(quotaKey(x))) ?? entries[0];
  if (!e) return plain;
  return {
    harness: e.harness,
    ...(e.model && e.model !== "default" ? { model: e.model } : {}),
    ...(e.credential ? { credential: e.credential } : {}),
    chain: [...order],
  };
}

/** What the runner knows about one installed harness, for a suggested order. */
export interface HarnessFacts {
  harness: HarnessId;
  /** a subscription login Tether can see (Claude, ChatGPT, Kiro); undefined: can't tell */
  signedIn?: boolean;
  /** the ChatGPT account of a Codex CLI or pi login, to skip the same account twice */
  account?: string;
  models: ModelRef[];
}

const real = (ms: ModelRef[]) => ms.filter((m) => m.id && m.id !== "default");

/**
 * A starting point for the default order editor, from what's installed and signed in: Claude Code
 * (the Opus its "opus" alias runs now, pinned), then Codex (its catalog's first model), then pi on its ChatGPT login when that's another
 * account than Codex's (the same model there when pi has it), then Kiro. Harnesses whose login
 * Tether can't see aren't guessed at, unless nothing else is there: then the first installed one.
 */
export function suggestOrder(facts: HarnessFacts[]): string[] {
  const of = (h: HarnessId) => facts.find((f) => f.harness === h);
  const out: string[] = [];
  const claude = of("claude-code");
  if (claude?.signedIn) {
    // The concrete Opus the alias runs now ("claude-opus-5-5"), so the order says which one.
    const ms = real(claude.models);
    const m = ms.find((x) => x.id === "opus") ?? ms.find((x) => /opus/i.test(x.id)) ?? ms[0];
    out.push(`claude-code:${m?.resolved ?? m?.id ?? "opus"}`);
  }
  const codex = of("codex");
  const codexModel = codex?.signedIn ? real(codex.models)[0]?.id : undefined;
  if (codexModel) out.push(`codex:${codexModel}`);
  const pi = of("pi");
  if (pi?.signedIn && !(codexModel && pi.account && pi.account === codex?.account)) {
    const ms = real(pi.models).filter((x) => x.id.startsWith("openai-codex/"));
    const m = ms.find((x) => codexModel && x.id === `openai-codex/${codexModel}`) ?? ms[0];
    if (m) out.push(`pi:${m.id}`);
  }
  const kiro = of("kiro");
  const kiroModel = kiro?.signedIn ? real(kiro.models)[0]?.id : undefined;
  if (kiroModel) out.push(`kiro:${kiroModel}`);
  if (!out.length) {
    const first = facts.find((f) => real(f.models).length);
    if (first) out.push(`${first.harness}:${real(first.models)[0]!.id}`);
  }
  return out;
}
