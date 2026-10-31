/** Only these sources are configurable. A missing slot means subscription. */
import type { TokenRates } from "./costs";
export type CredentialSource = "anthropic" | "openai" | "azure";
export interface CredentialSlot { set: boolean; last4?: string; endpoint?: string; deployment?: string; rates?: TokenRates }
export type CredentialStatus = Record<CredentialSource, CredentialSlot>;
