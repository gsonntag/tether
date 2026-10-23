// Credentials (.claude/credentials/SPEC.md): the accounts, logins and API keys a runner can run
// agents on, as the app sees them. Values (keys, tokens) never leave the runner: a view carries
// labels, where it came from, its state and the last 4 characters at most.
//
// Ids are "<provider>:<name>" ("azure:east-coast", "anthropic:work"): the provider part picks the
// runner plugin that owns it (runner/src/credentials/registry.ts). A chain entry names one with a
// "#<id>" suffix ("codex:gpt-6-luna#azure:east-coast"), see ChainEntry in protocol.ts.

import type { HarnessId, ModelRef, UsageWindow } from "./protocol";

export type CredentialKind = "login" | "apiKey" | "awsProfile" | "awsKeys";

/** Who the credential is for. Open-ended: a plugin may bring its own. */
export type CredentialProvider = "anthropic" | "openai" | "azure" | "bedrock" | "kiro" | "google" | (string & {});

/** Where the value lives: Tether's own store, the user's login shell, the runner's env, or a harness CLI's own login. */
export type CredentialSource = "tether" | "shell" | "env" | "cli";

export type CredentialState = "ok" | "expired" | "missing" | "unknown";

/** A model a credential serves, on one harness ("codex" runs "gpt-6-luna"; pi runs "azure/gpt-6-luna"). */
export interface CredentialModel extends ModelRef {
  harness: HarnessId;
}

/** One credential as the app sees it: never a value. */
export interface CredentialView {
  /** "<provider>:<name>" */
  id: string;
  kind: CredentialKind;
  provider: CredentialProvider;
  /** "Microsoft Foundry · east-coast-gavin-resource", "Max (gavin@)" */
  label: string;
  /** email, org, AWS account or profile */
  account?: string;
  /** endpoint host only ("east-coast.openai.azure.com"), never a full URL with a key in it */
  endpointHost?: string;
  region?: string;
  /** the last 4 characters of a stored key */
  last4?: string;
  source: CredentialSource;
  /** "from ~/.bashrc", "Codex profile azure-sol": where it came from, in words */
  sourceNote?: string;
  state: CredentialState;
  /** why it isn't ok, in a short sentence */
  stateNote?: string;
  /** when it was stored (epoch ms) */
  setAt?: number;
  models?: CredentialModel[];
  /** current usage windows, where the plugin reads them */
  usage?: UsageWindow[];
  /** filled in by the runner: "Default order #2", "3 sessions" */
  usedIn?: string[];
  /** provider-specific actions the row offers (credentialAction names), e.g. ["signIn", "addModel"] */
  actions?: string[];
}

/** What "Test" found: one cheap call. */
export interface CredentialTest {
  ok: boolean;
  /** "valid", "invalid", "quota", "wrong deployment"… */
  result: string;
  /** a short sentence for the row */
  message?: string;
}

/** A credential provider the runner has a plugin for, with what it can do (the Credentials page's groups). */
export interface CredentialProviderInfo {
  provider: CredentialProvider;
  /** "Microsoft Foundry" */
  label: string;
  /** provider-level actions (credentialAction with `id` = the provider), e.g. ["add"] */
  actions?: string[];
}

export interface CredentialList {
  providers: CredentialProviderInfo[];
  credentials: CredentialView[];
  /** plugins whose discovery failed, with why */
  errors?: { provider: string; error: string }[];
}

/** A credential id: "<provider>:<name>", no "#" or spaces. */
export const CREDENTIAL_ID = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9._@+-]{1,96}$/;
export const isCredentialId = (id: string) => CREDENTIAL_ID.test(id);

/** "azure:east-coast" → "azure". */
export const credentialProvider = (id: string) => id.slice(0, Math.max(0, id.indexOf(":")));
