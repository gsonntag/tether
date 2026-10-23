// A session that fails on a sign-in problem (SPEC section 4): which login to sign in again, so its
// error notice gets a "Sign in to Claude" button and Home's inbox row says so. Kept apart from
// accounts.ts so session.ts doesn't pull in the account plugins.

import { credentialProvider } from "../../../web/src/shared/credentials";
import type { ChainEntry } from "../../../web/src/shared/protocol";

/**
 * What the harnesses say when their own login is missing, expired or refused: Claude Code's
 * authentication_failed / "Invalid API key · Please run /login" / "OAuth token has expired", Codex's
 * refresh-token errors and "Not logged in", pi's provider 401.
 */
const AUTH_PHRASE =
  /authentication_failed|authentication_error|invalid (x-)?api[ _-]?key|invalid (bearer|access|oauth) token|oauth token (has )?expired|access token could not be refreshed|token_expired|refresh_token_(reused|expired|invalid)|not (logged|signed) in\b|please run \/login|run `?(claude|codex) login/i;
/** A bare 401 only when the error starts with it ("401 Unauthorized", "API Error: 401 …", "unexpected status 401 …"), not quoted from a tool's output. */
const AUTH_STATUS = /^(?:(?:api )?error:\s*)?(?:unexpected status\s+|status(?: code)?:?\s+)?(?:401\b|unauthori[sz]ed\b)/i;

/**
 * Whether a harness error means its login is refused (not a limit, not a network blip). Only the
 * error's first line counts: an agent's curl output or a tool error quoted further down that
 * mentions 401 or "unauthorized" isn't the harness's login failing.
 */
export function isAuthError(text: string | undefined): boolean {
  const head = (text ?? "").trim().split("\n")[0]!.slice(0, 400);
  return !!head && (AUTH_PHRASE.test(head) || AUTH_STATUS.test(head));
}

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
