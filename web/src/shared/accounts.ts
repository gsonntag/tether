// Harness logins and extra accounts (.claude/credentials/SPEC.md sections 3 and 4): the sign-in
// flows the runner relays to the browser. Shapes only; the runner side is
// runner/src/credentials/{accounts,signin}.ts, the page side web/src/credentials/accounts.tsx.

/**
 * A sign-in in progress on the runner, as the browser sees it (no token ever: the CLI writes the
 * login into the account's own home, and the pasted code isn't echoed back).
 *  - "paste": open `url` in a new tab, sign in, paste the code it shows (Claude Code).
 *  - "device": open `url` and enter `code` there (Codex device flow).
 *  - "command": no flow Tether can relay: run `command` on the runner; Tether notices when it's done.
 */
export interface SignInFlow {
  /** the credential it signs in ("claude:work") */
  id: string;
  kind: "paste" | "device" | "command";
  state: "starting" | "waiting" | "verifying" | "done" | "failed" | "cancelled";
  url?: string;
  /** the device code to enter at `url` (not a secret: you type it there) */
  code?: string;
  /** what to run on the runner (kind "command") */
  command?: string;
  /** what went wrong, or a hint */
  message?: string;
  /** the last lines the CLI printed, for when Tether couldn't read a link or code out of it */
  output?: string;
  startedAt: number;
}

/** What the sign-in actions answer (credentialAction's `result`): the flow, and its link/code at the top. */
export interface SignInResult {
  flow?: SignInFlow;
  message?: string;
  url?: string;
  code?: string;
}

/** Names an extra account can't take: they're the machine's own logins. */
export const RESERVED_ACCOUNT_NAMES = ["machine", "codex", "pi"];

/** "work", "gavin.personal": what goes after "claude:" in an extra account's id. */
export const ACCOUNT_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** The id-safe form of what someone typed as an account name. */
export const accountSlug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|-+$/g, "")
    .slice(0, 32);
