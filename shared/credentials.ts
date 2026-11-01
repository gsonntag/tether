/** The keys a runner can hold. All can be set at once: a session picks one, or its subscription. */
import type { TokenRates } from "./costs";
import type { Billing } from "./transcript";
export type CredentialSource = "anthropic" | "openai" | "azure";
export interface CredentialSlot { set: boolean; last4?: string; endpoint?: string; deployment?: string; rates?: TokenRates }
export type CredentialStatus = Record<CredentialSource, CredentialSlot>;

/** What one session draws from. It's chosen when the session is made and kept with it. */
export type BillingSource = CredentialSource | "subscription";
export const isBillingSource = (v: unknown): v is BillingSource => v === "subscription" || v === "anthropic" || v === "openai" || v === "azure";

/** A source that really exists for a harness now: a login it reports, or a key that's set. */
export interface SourceOption {
  source: BillingSource;
  /** what it's called and whether it's billed by the token; the harness confirms it at each start */
  billing: Billing;
  /** Azure's deployment: it is the model on that source */
  deployment?: string;
}
export interface SourceChoices {
  options: SourceOption[];
  /** the last one chosen for this harness on this runner, else the subscription */
  default?: BillingSource;
}
