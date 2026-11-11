# P7 acceptance: sessions talking to each other

Checks for SPEC §9a. `unit` is `runner/src/modules/peers/peers.test.ts`; `real` was run on an
isolated stack (2026-11-11) with Claude Code 2.1.322 on Haiku 4.5 and Codex (daemon 0.167.1) on
GPT-5.6-Luna, Low. "Phone" is 390 × 844 with touch.

## Setup

A private stack, and a private Codex app-server so the user's daemon is never touched:

```sh
D=/tmp/peers-test; mkdir -m 700 -p $D/cfg $D/codex-home $D/sock
echo '{"runnerId":"peers-test"}' > $D/cfg/runner.json
cp ~/.codex/auth.json $D/codex-home/ && : > $D/codex-home/config.toml
CODEX_HOME=$D/codex-home ~/.codex/packages/app-server-daemon/current/bin/codex app-server --listen unix://$D/sock/codex.sock
cd server && env -u TETHER_URL -u TETHER_TOKEN PORT=8891 bun src/index.ts
cd web && VITE_PORT=5191 TETHER_SERVER=http://localhost:8891 bunx vite
cd runner && TETHER_DEV=1 TETHER_URL=http://localhost:8891 TETHER_TOKEN=dev TETHER_CONFIG_DIR=$D/cfg TETHER_NO_RESUME=1 \
  TETHER_TMUX_SOCKET=peers-test CODEX_HOME=$D/codex-home CODEX_DAEMON_SOCKET=$D/sock/codex.sock bun src/index.ts
```

The runner still reads your real Claude store, so the lists show your real sessions: always give
broadcasts a project filter in tests.

## Checks

| # | Check | Result |
|---|---|---|
| 1 | Claude A: "tether_sessions, then tether_ask session B 2+2". | real: B shows "From “Alpha”", answers 4; A's tool returns "“Bravo” answered: 4". |
| 2 | Claude → Codex ask. | real: Codex thread answered "Paris"; A's card "Asked “Charlie”". |
| 3 | Codex → Claude ask (read-only Codex, no prompt). | real: the MCP call ran without approval; answer 6. |
| 4 | Ask while the target is mid-turn; cancel it from the queue. | real: the question waited in B's queue (not steered); cancelling returned "Not delivered: the person removed your question from “Bravo”'s queue." unit too. |
| 5 | Broadcast with a project filter; a second one; the receiver broadcasting. | real: only projA's other session got "From “Alpha” · to all"; the second was refused (10 minutes); the receiver's was refused ("started with a note to all"); each refusal also a warning notice. |
| 6 | Broadcast matching more than 20 sessions. | real: refused, "38 sessions match (at most 20 at once)". |
| 7 | Send to all from the UI, project filter, one target mid-turn, one stored. | real: "Queued in 2 sessions" with links, as your own message in each; the stored one started. The mid-turn wait is the queue of #4 (not seen separately: the other session had just gone idle). |
| 8 | Two sessions told to keep a counting game going. | real: stopped at the 5th message ("would be the 5th in a chain"), with a notice. |
| 9 | Marker parse, defang, tool kind, caps, token identity, socket, stdio server. | unit |
| 10 | Restart the runner during an open ask. | unit: a runner that is away says nothing was sent; one cut off mid-call says the message may already be queued (check with tether_sessions). The queued question is the core queue's (runner.json), and its hops survive with it. |
| 11 | Screenshots: origin bubble, tool cards, Send to all, desktop and phone. | by hand |
| 12 | A plan-mode session sends to a bypassPermissions one; unknown modes; a broadcast over mixed modes; the receiver's hint. | unit (peers.test.ts "a stricter session can't message a looser one"). Refused with "doesn't have permission", nothing queued, a notice in the sender. |
| 13 | An agent's broadcast without project or scope; with `project`; with `scope: "all"`. | unit: its own project only; the named one; every project. The person's Send to all is unchanged. |
