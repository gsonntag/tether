// A session that fails on a sign-in problem (SPEC section 4): which login to sign in again, so its
// error notice gets a "Sign in to Claude" button and Home's inbox row says so. Kept apart from
// accounts.ts so session.ts doesn't pull in the account plugins.

import { credentialProvider } from "../../../web/src/shared/credentials";
import type { ChainEntry } from "../../../web/src/shared/protocol";

/** Error text that means the login is missing, expired or refused (not a limit, not a network blip). */
const AUTH =
  /authentication_failed|authentication[_ ]error|invalid (x-)?api[ _-]?key|invalid (bearer|access|oauth) token|oauth token (has )?expired|token (has )?(expired|been revoked)|token_expired|refresh_token_(reused|expired|invalid)|could not refresh|not (logged|signed) in|please (run )?\/login|log ?in again|sign in again|re-?authenticate|\b401\b|unauthori[sz]ed/i;

export const isAuthError = (text: string | undefined) => !!text && AUTH.test(text);

/** The login (credential id) a harness runs on, and its provider's name: the machine's own unless the entry names one of ours. */
export function loginOf(entry: ChainEntry): { credential: string; provider: string } | undefined {
  const own = entry.credential;
  const ours = (p: string, machine: string, name: string) => {
    if (own && credentialProvider(own) !== p) return undefined; // another plugin's key (Foundry, Bedrock…)
    return { credential: own ?? machine, provider: name };
  };
  switch (entry.harness) {
    case "claude-code":
      return ours("claude", "claude:machine", "Claude");
    case "codex":
      return entry.model.includes("/") && !own ? undefined : ours("chatgpt", "chatgpt:codex", "ChatGPT");
    case "pi":
      return entry.model.startsWith("openai-codex/") ? ours("chatgpt", "chatgpt:pi", "ChatGPT") : undefined;
    case "kiro":
      return own ? undefined : { credential: "kiro:machine", provider: "Kiro" };
    case "antigravity":
      return own ? undefined : { credential: "antigravity:machine", provider: "Antigravity" };
    default:
      return undefined;
  }
}

/** For an error notice: the login to sign in again, when the error is a sign-in problem on one of ours. */
export function signInFor(entry: ChainEntry, text: string | undefined): { credential: string; provider: string } | undefined {
  return isAuthError(text) ? loginOf(entry) : undefined;
}
