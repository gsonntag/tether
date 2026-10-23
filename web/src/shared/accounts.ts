// Harness logins and extra accounts (.claude/credentials/SPEC.md sections 3 and 4): account names,
// shared by the runner (runner/src/credentials/{accounts,signin}.ts) and the page
// (web/src/credentials/accounts.tsx).
//
// A sign-in's steps reach the page as CredentialActionResults (shared/credentials.ts), see
// runner/src/credentials/accounts.ts flowResult: while one is still going its answer carries `id`
// (the page asks again with "signInStatus"); a link to open is `url`, a device code `code`, the code
// to paste back is asked for with `next` ("signInCode"); a command to run on the runner is in `message`.

/** The actions a sign-in answers (accounts' plugins): its state now, the code you paste, cancel. */
export const SIGN_IN_STEPS = { status: "signInStatus", code: "signInCode", cancel: "signInCancel" } as const;

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
