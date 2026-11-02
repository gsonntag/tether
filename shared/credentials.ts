/** The keys a runner can hold. All can be set at once: a session picks one, or its subscription. */
import type { TokenRates } from "./costs";
import type { AzureType } from "./azureRates";
import type { Billing, HarnessId } from "./transcript";
export type CredentialSource = "anthropic" | "openai" | "azure";
/** The keys each harness can use. */
export const HARNESS_KEYS: Record<HarnessId, CredentialSource[]> = { claude: ["anthropic"], codex: ["openai", "azure"] };
/**
 * One Azure deployment: the name requests use as their model, the model it runs and its type, which
 * find its rates in Tether's Azure table, and `rates`: the owner's own, used instead (Override).
 */
export interface AzureDeployment { name: string; model?: string; type?: AzureType; rates?: TokenRates }
/** Azure's settings are public metadata, kept apart from its key: either can be set first. */
export interface CredentialSlot { set: boolean; last4?: string; endpoint?: string; deployments?: AzureDeployment[] }
export type CredentialStatus = Record<CredentialSource, CredentialSlot>;

/** What one session draws from. It's chosen when the session is made and kept with it. */
export type BillingSource = CredentialSource | "subscription";
export const isBillingSource = (v: unknown): v is BillingSource => v === "subscription" || v === "anthropic" || v === "openai" || v === "azure";

/** A source that really exists for a harness now: a login it reports, or a key that's set. */
export interface SourceOption {
  source: BillingSource;
  /** what it's called and whether it's billed by the token; the harness confirms it at each start */
  billing: Billing;
  /** Azure's deployments: on that source, the model is one of these */
  deployments?: { name: string; model?: string }[];
  /** a runner from before deployment lists: its one deployment */
  deployment?: string;
}
/** Available fallback keys, in the user's order. An explicit list excludes every omitted key. */
export function keyTargets(options: SourceOption[], lastKey?: BillingSource, order?: CredentialSource[]): SourceOption[] {
  const keys = options.filter((o) => o.source !== "subscription");
  if (order !== undefined) return [...new Set(order)].flatMap((source) => keys.filter((o) => o.source === source));
  const last = keys.find((o) => o.source === lastKey);
  return last ? [last, ...keys.filter((o) => o !== last)] : keys;
}
/** The first available, allowed key. Unset or excluded keys never become a fallback. */
export function keyTarget(options: SourceOption[], lastKey?: BillingSource, order?: CredentialSource[]): SourceOption | undefined {
  return keyTargets(options, lastKey, order)[0];
}
export interface SourceChoices {
  options: SourceOption[];
  /** the last one chosen for this harness on this runner, else the subscription */
  default?: BillingSource;
}

/**
 * Where Codex's Azure provider sends requests: the v1 API, `https://<resource>.openai.azure.com/openai/v1`,
 * which takes no `api-version`. A resource name is made into that; a URL (a Foundry resource's
 * `https://<name>.services.ai.azure.com`, say) is used as given, with `/openai/v1` when it has no path.
 */
export function azureEndpoint(input: string): string | undefined {
  const value = input.trim();
  if (/^[a-z0-9][a-z0-9-]{0,62}$/i.test(value)) return `https://${value.toLowerCase()}.openai.azure.com/openai/v1`;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/openai/v1"}`;
}
/** The resource name an endpoint was made from, if it was. */
export const azureResource = (endpoint?: string) => endpoint?.match(/^https:\/\/([a-z0-9][a-z0-9-]*)\.openai\.azure\.com\/openai\/v1$/)?.[1];
export const AZURE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
export const AZURE_MAX_DEPLOYMENTS = 50;
