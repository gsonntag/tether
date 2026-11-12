// Several people on one Tether app. Without TETHER_RUNNER_OWNERS the app has one tenant: every
// owner of the app sees and drives every runner (the original design). With it, each runner
// service token belongs to named people, and the relay shows a browser only the runners whose
// token lists them: the runner list, summaries, Home chats, presence and every rpc are checked.
//
//   TETHER_RUNNER_OWNERS='{"runner-alice":["alice@example.com"],"runner-bob":["bob@example.com"]}'
//
// - Keys are runner service token names (runnerIds.ts binds a token to its runner ids).
// - Values list who may use that token's runners: emails (any case) or Foliation user ids (sub).
// - A runner whose token isn't listed is refused at hello, so a forgotten entry fails closed.
// - People listed here may sign in with any app role (a viewer share is enough), so the app's
//   Foliation owner can be an operator who isn't a tenant: viewers can't change the app's env or
//   tokens. Unlisted app owners can still sign in, and see no runners.

export type RunnerOwners = ReadonlyMap<string, ReadonlySet<string>>;

/** Who is asking: a browser's Foliation user id and email. */
export interface Who {
  id: string;
  email: string;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * The owner map from its env value: null when unset or blank (one tenant). Throws on anything
 * malformed, so a typo stops the server instead of opening it up.
 */
export function parseRunnerOwners(raw: string | undefined): RunnerOwners | null {
  if (raw === undefined || !raw.trim()) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error("TETHER_RUNNER_OWNERS isn't valid JSON: expected {\"runner-<name>\": [\"email or user id\", …], …}");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("TETHER_RUNNER_OWNERS must be a JSON object of token name → list of people");
  const out = new Map<string, ReadonlySet<string>>();
  for (const [token, people] of Object.entries(v)) {
    if (!/^runner(-|$)/.test(token)) throw new Error(`TETHER_RUNNER_OWNERS: "${token}" isn't a runner token name (runner or runner-<name>)`);
    if (!Array.isArray(people) || people.some((p) => typeof p !== "string" || !p.trim() || p.trim().startsWith("anon:") || p.trim().startsWith("svc:")))
      throw new Error(`TETHER_RUNNER_OWNERS: "${token}" needs a list of emails or user ids`);
    out.set(token, new Set((people as string[]).map(norm)));
  }
  if (!out.size) throw new Error("TETHER_RUNNER_OWNERS is empty: unset it for a single-tenant app");
  return out;
}

/** Whether this person may use runners connected with this token. Always true without a map. */
export function mayUseRunner(owners: RunnerOwners | null | undefined, token: string, who: Who): boolean {
  if (!owners) return true;
  const people = owners.get(token);
  if (!people) return false;
  return (!!who.id && people.has(norm(who.id))) || (!!who.email && people.has(norm(who.email)));
}

/** Whether this person is named anywhere in the map (so may sign in without being an app owner). */
export function listedTenant(owners: RunnerOwners | null | undefined, who: Who): boolean {
  if (!owners) return false;
  for (const token of owners.keys()) if (mayUseRunner(owners, token, who)) return true;
  return false;
}
