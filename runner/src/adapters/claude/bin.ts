// The `claude` binary the SDK runs (CLAUDE_BIN, else the one on PATH). Without one the SDK would
// use the copy it bundles, which may lag the installed CLI and its login.
export const CLAUDE_BIN: string | undefined = process.env.CLAUDE_BIN || Bun.which("claude") || undefined;
