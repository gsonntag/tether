// The environment for anything the runner starts (harnesses, git, tmux, shells): the runner's own,
// minus Tether's secrets. On Bun a child started without `env` gets the environment the runner
// STARTED with, whatever was deleted from process.env since, so every spawn passes one
// (childEnv.test.ts checks). Agents run as the same user and can still read files the runner can:
// this only keeps the secrets out of their environment.

/** Tether's own secrets: the service token, the texting connectors' keys, push's private key, keys for harnesses (handed over another way). */
const SECRET = /^TETHER_(TOKEN|DISCORD_|PHOTON_|TEXT_PHONE|VAPID_PRIVATE_KEY|CLAUDE_API_KEY|CODEX_API_KEY|GATEWAY_KEY|PEERS_TOKEN)/;

export const isRunnerSecret = (name: string) => SECRET.test(name);

/** process.env (now) without Tether's secrets, plus `extra`. */
export function childEnv(extra: Record<string, string | undefined> = {}, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !SECRET.test(k)) out[k] = v;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}
