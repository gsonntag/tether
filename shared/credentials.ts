/** The keys a runner can hold. All can be set at once: a session picks one, or its subscription. */
import type { TokenRates } from "./costs";
import type { AzureType } from "./azureRates";
import { HARNESS_LABELS, type Billing, type HarnessId } from "./transcript";
export type CredentialSource = "anthropic" | "openai" | "azure" | "bedrock";
/** The keys each harness can use. */
export const HARNESS_KEYS: Record<HarnessId, CredentialSource[]> = { claude: ["anthropic", "bedrock"], codex: ["openai", "azure", "bedrock"], antigravity: [] };
/**
 * One Azure deployment: the name requests use as their model, the model it runs and its type, which
 * find its rates in Tether's Azure table, and `rates`: the owner's own, used instead (Override).
 */
export interface AzureDeployment { name: string; model?: string; type?: AzureType; rates?: TokenRates }
/** Azure's settings are public metadata, kept apart from its key: either can be set first. */
export interface CredentialSlot { set: boolean; last4?: string; endpoint?: string; deployments?: AzureDeployment[] }
export const BEDROCK_LABEL = "Amazon Bedrock";
export interface BedrockModel { id: string; harness: "claude" | "codex"; alias?: string; rates?: TokenRates; cacheWriteLong?: number }
export interface BedrockSettings {
  region: string;
  auth: "key" | "profile";
  profile?: string;
  models: BedrockModel[];
  dailyLimitUsd?: number;
}
// Older runners do not send the Bedrock slot.
export type CredentialStatus = Record<Exclude<CredentialSource, "bedrock">, CredentialSlot> & { bedrock?: CredentialSlot & { settings?: BedrockSettings } };

/** What one session draws from. It's chosen when the session is made and kept with it. */
export type AccountSource = `account:${string}`;
export const isAccountSource = (v: unknown): v is AccountSource =>
  typeof v === "string" && /^account:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export type BillingSource = CredentialSource | "subscription" | AccountSource;
export const isCredentialSource = (v: unknown): v is CredentialSource => v === "anthropic" || v === "openai" || v === "azure" || v === "bedrock";
export const isSubscriptionSource = (v: BillingSource) => v === "subscription" || isAccountSource(v);
export const isBillingSource = (v: unknown): v is BillingSource => v === "subscription" || isCredentialSource(v) || isAccountSource(v);
export const hasSourceModels = (source: BillingSource): source is "azure" | "bedrock" => source === "azure" || source === "bedrock";

/** Runner-style opaque label for a billing source without needing fallbackSetup (G8). */
export function sourceLabel(harness: HarnessId, source: BillingSource): string {
  if (source === "anthropic") return "Anthropic API key";
  if (source === "openai") return "OpenAI API key";
  if (source === "azure") return "Azure";
  if (source === "bedrock") return BEDROCK_LABEL;
  if (isAccountSource(source)) return `Claude plan · ${source.slice(8, 16)}`;
  if (harness === "claude") return "Claude plan";
  if (harness === "codex") return "ChatGPT plan";
  return `${HARNESS_LABELS[harness]} login`;
}

/** Human-readable label when a saved step's source is missing from the runner catalog (never raw ids). */
export function missingSourceLabel(harness: HarnessId, source: BillingSource): string {
  if (isAccountSource(source)) return "Removed Claude account";
  if (source === "azure") return "Azure (not set up)";
  if (source === "bedrock") return "Bedrock (not set up)";
  if (source === "anthropic") return "Anthropic key (not set)";
  if (source === "openai") return "OpenAI key (not set)";
  return `${HARNESS_LABELS[harness]} login unavailable`;
}

/** A source that really exists for a harness now: a login it reports, or a key that's set. */
export interface SourceOption {
  source: BillingSource;
  /** what it's called and whether it's billed by the token; the harness confirms it at each start */
  billing: Billing;
  /** Models configured for the source, using their request names */
  deployments?: { name: string; model?: string }[];
  /** a runner from before deployment lists: its one deployment */
  deployment?: string;
}
/** Resolve a deployment name or an unambiguous model alias. With no model, use the first deployment. */
export function resolveSourceModel(deployments: NonNullable<SourceOption["deployments"]>, model?: string): string | undefined {
  if (!model) return deployments[0]?.name;
  const named = deployments.find(({ name }) => name === model);
  if (named) return named.name;
  const matches = deployments.filter((deployment) => deployment.model === model);
  return matches.length === 1 ? matches[0]?.name : undefined;
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
