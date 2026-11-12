# Multi-tenant test plan: Tether on one AWS t4g.xlarge

Status: ready to run, not run. Nothing here has been executed or launched. The sizing comes from
the 2026-11-12 sizing study (t4g.large is too small; t4g.xlarge fits 3 tenants × 2–4 sessions).

**Target:** one t4g.xlarge (Graviton2 arm64, 4 vCPU, 16 GiB, burstable at 40 % per vCPU) running
the Foliation platform, one or more Tether apps, and **three tenants** (alice, bob, carol). Each
tenant has their own Linux user and runner and runs 2–4 agent sessions at once (about 9–12 in total).

## 1. The tenancy model

Tether has three layers, and each one keeps tenants apart in its own way:

| Layer | What separates tenants |
|---|---|
| **Server** (a Foliation app: the UI plus a stateless relay) | Either **one app per tenant** (model A), or **one shared app with `TETHER_RUNNER_OWNERS`** (model B). With model B the relay shows each person only their own runners. That covers the runner list, summaries, Home chats, presence and every rpc (`server/src/tenancy.ts`). |
| **Runner** (one per tenant) | Its own **Linux user**, systemd user unit, `~/.config/tether`, `~/.claude`, `~/.codex`, checkouts, tmux server and Codex daemon. Everything a runner serves locally is a Unix socket (mode 600) in a 700 folder. The one TCP listener, the private Codex proxy for API-key sessions, requires a random bearer kept in a private file. |
| **Agents** | Run as the tenant's Linux user, so a tenant's agent can do anything that user can. They can't do more: no `sudo`, no `docker` group, and no shared writable folders. |

Everything a runner holds belongs to its one tenant: sessions, the Home agent, texting
connectors, short links, peers, push subscriptions, credentials and billing sources, harness
updates, and notices. None of these features can reach another runner. Peers use a local socket.
Short links resolve through the `resolveLink` rpc, which the relay gates. Texting replies route
by message ids kept on the runner.

- **Model A (separate apps):** each tenant's org deploys its own `tether` app, and no Tether
  process is shared. This is the strongest separation and needs no Tether configuration. Use it
  when tenants are different orgs.
- **Model B (one shared app):** use it when the tenants are people in one org. The operator owns
  the app, and tenants get a **viewer** share. Viewers can't change the app's env or tokens, and the
  owner map lets them in anyway. **Tenants must not be org admins**, because Foliation makes
  admins owners of every app, and an owner can edit `TETHER_RUNNER_OWNERS`.

This plan runs **model B** for all three tenants, because it is the one with Tether code to test.
One extra org with its own app (model A) costs about 50 MB more and can run alongside it.

## 2. Bootstrapping the host (commands; not executed)

### 2.1 Instance

- **Instance and disk:** t4g.xlarge, Ubuntu 24.04 LTS arm64, 60 GB gp3. Keep **Unlimited** credits
  (the default), and add a CloudWatch alarm on `CPUSurplusCreditsCharged`.
- **Security group:** 22 from your IP only. All web traffic goes out through cloudflared, so no
  inbound 80 or 443.

### 2.2 Base packages, swap, /proc hardening

```sh
sudo apt-get update && sudo apt-get install -y git tmux imagemagick unzip curl jq build-essential
# 4 GB swap: a peak should slow down, not OOM-kill an agent
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/90-swap.conf && sudo sysctl --system
# Hide other users' processes: argv and /proc entries stop leaking between tenants
sudo groupadd -f procview
echo 'proc /proc proc defaults,nosuid,nodev,noexec,hidepid=invisible,gid=procview 0 0' | sudo tee -a /etc/fstab
sudo mount -o remount,hidepid=invisible,gid=procview /proc
sudo usermod -aG procview ubuntu        # the operator account keeps seeing everything for monitoring
# Private home folders (Ubuntu 24.04 defaults to 750; make it 700)
sudo sed -i 's/^HOME_MODE.*/HOME_MODE 0700/' /etc/login.defs
```

`systemd-logind` needs to see processes too. Add the drop-in
`/etc/systemd/system/systemd-logind.service.d/hidepid.conf` containing
`[Service]\nSupplementaryGroups=procview`, then run `sudo systemctl daemon-reload && sudo systemctl restart systemd-logind`.

### 2.3 Foliation

Follow `~/foliation/docs/single-host.md` §7 (signed release, `install.sh --version <V> …`).
Pick the arm64 tarball: `foliation_<ver>_linux_arm64.tar.gz`. On 16 GiB, lower the 23 GB budgets
in `/etc/foliation/common.env` and the slice drop-ins:

- **Builds:** `FOLIATION_BUILD_MEMORY_BUDGET_MB=3072` and `FOLIATION_BUILD_MEMORY_RESERVATION_MB=1536`,
  which allows 2 builds at once.
- **Apps:** `FOLIATION_APP_MEMORY_BUDGET_MB=3072`.
- **Postgres:** apps Postgres `shared_buffers=512MB`, `max_connections=100`; platform Postgres
  `shared_buffers=256MB`.
- **Docker:** add a timer for `docker builder prune -f --keep-storage 8GB`.

Then, as the operator:

```sh
fol login --label t4g-test
fol orgs create tether-test && fol orgs use tether-test
fol members add alice@example.com && fol members add bob@example.com && fol members add carol@example.com   # members, never --admin
```

### 2.4 The shared Tether app

From a checkout of Tether `main` on any machine with `fol`:

```sh
git clone https://github.com/gsonntag/tether.git tether && cd tether
fol deploy --app tether                     # foliation.json: frontend web/, backend server/
bun server/scripts/vapid-keys.ts            # prints a key pair for push
fol env set tether TETHER_VAPID_PUBLIC_KEY=<pub>
fol env set tether TETHER_VAPID_PRIVATE_KEY --secret      # paste <priv> on stdin
fol env set tether TETHER_PUSH_SUBJECT=mailto:ops@example.com
fol env set tether 'TETHER_RUNNER_OWNERS={"runner-alice":["alice@example.com"],"runner-bob":["bob@example.com"],"runner-carol":["carol@example.com"]}'
fol restart tether
fol share tether alice@example.com --role viewer
fol share tether bob@example.com --role viewer
fol share tether carol@example.com --role viewer
for t in alice bob carol; do fol tokens create tether --service runner-$t --role editor --expires 90d; done   # note each token once
```

The server logs `Several tenants: 3 runner token(s) in TETHER_RUNNER_OWNERS…` at start. A
malformed value stops the server instead of opening it up. Check with `fol logs tether`.

### 2.5 One Linux user and runner per tenant

The repository is private: give each tenant user a read-only deploy key (or clone once as the
operator and copy the checkout into each home, then `chown -R`).

Run this for each of `alice`, `bob` and `carol` (shown for alice):

```sh
T=alice
sudo adduser --disabled-password --gecos "" $T          # not in sudo, docker, lxd or adm
sudo chmod 700 /home/$T
sudo loginctl enable-linger $T
# A cap for everything this user runs: the runner and its agents, plus the tmux and Codex scopes
sudo mkdir -p /etc/systemd/system/user-$(id -u $T).slice.d
printf '[Slice]\nMemoryHigh=3.5G\nMemoryMax=4.5G\nTasksMax=2048\nCPUWeight=100\n' | sudo tee /etc/systemd/system/user-$(id -u $T).slice.d/50-tenant.conf
sudo systemctl daemon-reload

sudo -iu $T bash <<'EOS'
set -e
curl -fsSL https://bun.sh/install | bash                                  # bun for linux-aarch64
curl -fsSL https://claude.ai/install.sh | bash                            # Claude Code native, per user (~/.local/bin)
mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global 2>/dev/null || true
# Codex: per user. It ships aarch64-unknown-linux-musl. Use npm if node is installed, else the release tarball.
command -v npm && npm i -g @openai/codex
git clone https://github.com/gsonntag/tether.git ~/tether-prod && git -C ~/tether-prod checkout --detach origin/main
(cd ~/tether-prod/runner && ~/.bun/bin/bun install --frozen-lockfile)
(cd ~/tether-prod/shared && ~/.bun/bin/bun install --frozen-lockfile)
mkdir -p ~/.config/tether && chmod 700 ~/.config/tether
echo '{"runnerId":"runner-'"$USER"'","name":"'"$USER"'"}' > ~/.config/tether/runner.json && chmod 600 ~/.config/tether/runner.json
install -m600 ~/tether-prod/deploy/runner.env.example ~/.config/tether/runner.env
install -Dm644 ~/tether-prod/deploy/tether-runner.service ~/.config/systemd/user/tether-runner.service
EOS
```

Next, for each tenant:

1. **runner.env:** edit `/home/$T/.config/tether/runner.env`. Set `TETHER_URL` to the app's URL,
   `TETHER_TOKEN` to that tenant's `runner-$T` token, and `TETHER_MAX_LIVE_SESSIONS=4`.
2. **Harness logins:** sign in to each harness as the tenant (`sudo -iu $T`): `claude` (`/login`)
   and `codex login --device-auth`. **Each tenant needs their own subscription logins.** Never copy
   `~/.claude` or `~/.codex` between users.
3. **Start the runner:** `sudo -iu $T XDG_RUNTIME_DIR=/run/user/$(id -u $T) systemctl --user enable --now tether-runner`.
4. **Check the logs:** run `journalctl --user -u tether-runner` as the tenant. You should see
   `connected`. A wrong token or id shows a close `4004` with the reason.

### 2.6 Limits that fit 4 vCPU / 16 GiB

| Where | Setting | Why |
|---|---|---|
| runner unit (`deploy/tether-runner.service`) | `MemoryHigh=3G`, `MemoryMax=4G`, `TasksMax=1024` | the runner and its Claude sessions and their tools |
| `user-<uid>.slice` | `MemoryHigh=3.5G`, `MemoryMax=4.5G` | adds tmux terminals, the Codex daemon and private Codex hosts, which run in their own scopes |
| `runner.env` | `TETHER_MAX_LIVE_SESSIONS=4` | a 5th session sending gets "This runner already has 4 live sessions…". Home chats, subagents and sessions rejoining after a restart are exempt |
| Foliation | §2.3 | builds and apps can't take everything |

Expected memory: about 0.3 GiB per Claude session, 0.1 GiB per Codex session, and 0.3–0.5 GiB per
runner. Three tenants with 4 sessions each come to about 5–6 GiB on Tether's side, plus about
2.5 GiB of steady Foliation. That leaves about 4 GiB for peaks (dev servers, Chromium, a build).

## 3. Test checklist

Tick each item. Run the isolation items from **two browsers signed in as different tenants** at the
same time.

### Bootstrap

- [ ] `uname -m` is `aarch64`. As each tenant, `bun --version`, `claude --version`,
  `codex --version` and `tmux -V` all work.
- [ ] All three runners show `connected` in their journals. Each tenant's Home shows exactly one
  runner, their own.
- [ ] The operator (an app owner who isn't in the owner map) signs in and sees no runners.
- [ ] Someone in the org who isn't in the map (a viewer share via `--org`) gets "owners only".

### Isolation: server (model B)

- [ ] Alice's sidebar, Recent, Home inbox and search never show bob's or carol's sessions.
- [ ] **Forged rpc:** in alice's browser devtools, send an rpc with bob's runner id, for example
  `{"t":"rpc","id":"x","runnerId":"runner-bob","op":"listSessions","args":{}}` over the open
  socket. The answer is "That runner is offline.", and bob's runner journal shows nothing.
- [ ] Repeat the forged rpc for `subscribe`, `send`, `setSessionArchived`, `resolveLink`,
  `openTerminal`, `setCredential` and `updateHarness`. Every one is refused.
- [ ] **Short link:** open bob's `#/l/<code>` in alice's browser. It doesn't resolve, and it shows
  nothing of bob's.
- [ ] **Presence:** alice sends presence with bob's runner id. Bob's runner gets no viewers frame
 .
- [ ] **Unmapped token:** start a 4th runner with a token that isn't in the map. It gets close
  `4004` "…has no owner in TETHER_RUNNER_OWNERS".
- [ ] **Token theft:** start a runner with alice's token but `runnerId: "runner-bob"`. It's refused
  with `4004`, and bob stays connected.

### Isolation: host

- [ ] As bob, `ps aux` shows only bob's processes (`hidepid`), and `ls /home/alice` is denied.
- [ ] As bob, `ss -ltn` may list a loopback port belonging to alice's private Codex proxy. Calling
  it with `curl -H 'Authorization: Bearer tether-private-<anything>'` returns 401.
- [ ] As bob, `cat /home/alice/.config/tether/runner.json` and `ls /run/user/<alice uid>` are denied.
- [ ] Inside a bob session, `tether_sessions` (the peers tool) lists only bob's sessions. A
  `tether_send` to one of alice's session ids fails.
- [ ] Bob's terminal (❯_) runs as `bob`: `id` prints bob's uid, and `tmux -L tether ls` shows
  only bob's terminals.

### Features, per tenant

- [ ] **Sessions:** 2 Claude and 1 Codex session working at once (3 tenants, 9 sessions in all).
  Then push one tenant to 4, and check that a 5th is refused with the limit message.
- [ ] **Home agent:** each tenant asks Home to start a session in their own project. It can't see
  the others' projects.
- [ ] **Check-in and archive:** "archive done sessions" in alice's Home touches only alice's sessions.
- [ ] **Billing sources:** alice adds an Anthropic API key under Settings → Credentials. Bob's
  Credentials page still shows none, and bob's sessions stay on his subscription.
- [ ] **Harness updates:** alice runs "update Claude". Only `/home/alice/.local/share/claude`
  changes, and bob's `claude --version` doesn't.
- [ ] **Push:** each tenant turns on notifications on a phone. A permission request in alice's
  session notifies only alice's devices.
- [ ] **Texting** (optional): each tenant uses **their own** Photon project or Discord bot and their
  own number. A text from alice's phone reaches only alice's Home, and a reply goes back only to alice.
- [ ] **Restarts:** restart alice's runner while bob has a turn running. Bob's turn isn't affected,
  and alice's running turns continue after the restart.

### Load

- [ ] Hold 9–12 sessions active for 30 minutes, with at least one running a test suite or a dev
  server, while one Foliation build runs.
- [ ] No OOM kills (`journalctl -k | grep -i oom` is empty) and no swap thrash (`vmstat 5`:
  `si`/`so` near 0).

## 4. What to monitor

- **Memory:** `systemd-cgtop -m` (per-user slices and runner units), `free -h`, and
  `cat /sys/fs/cgroup/user.slice/user-<uid>.slice/memory.events` (watch `high`, `max` and `oom_kill`).
- **Memory pressure:** `cat /proc/pressure/memory` and `/proc/pressure/cpu`. A `some avg60` over 10
  for long means you're over capacity.
- **CPU credits:** CloudWatch `CPUCreditBalance`, `CPUSurplusCreditsCharged` and `CPUUtilization`.
  A sustained average over 40 % (1.6 vCPU) bills surplus.
- **Runners:** each tenant's `journalctl --user -u tether-runner -f`. Watch for disconnects, `4004`,
  `rejoined`, and the limit message.
- **Server:** `fol logs tether -f` (refused runners, `closed a browser socket…`) and `fol errors tether`.
- **Disk:** `df -h /`, `docker system df`, and `du -sh /home/*/.claude/projects`.

## 5. Known gaps and follow-ups

These are outside this change and scoped for later:

1. **Push subscriptions aren't tied to a user.** A device that subscribed to a runner before the
   owner map was turned on (or while that person could see it) keeps getting its notifications.
   The notifications carry only project folder names. *For the test:* start from fresh runners, or
   delete `modules/push/push.json` in each runner's config folder when switching to model B.
   *Follow-up:* the relay stamps the subscribing user on `subscribePush`, and runners drop
   subscriptions whose user may no longer use them.
2. **The owner map is static.** Changing it needs `fol env set …` and a server restart. Browser
   sockets close within 5 minutes of a share being revoked (renew tickets). *Follow-up:* an admin
   page, or a Foliation group per runner.
3. **Shared texting credentials expose texts.** If two tenants configure the same Photon project or
   Discord bot token, either can read the other's messages. Routing is still per runner, so replies
   don't cross. *Follow-up:* the server refuses a second runner that reports the same connector
   identity.
4. **Terminals and shells don't count toward `TETHER_MAX_LIVE_SESSIONS`.** Only the per-user slice
   caps them.
5. **The Home agent's prompt says "every session on this machine".** It means this runner. That's
   accurate per tenant, but the wording is single-user.
6. **No provisioner.** Tenants are made by hand (§2.5). SPEC §1's "provisioner module" for cloud
   containers is the follow-up.
7. **Private Codex hosts from before this change** use a bearer derived from the session id. On an
   existing host, run `systemctl --user stop 'tether-key-*.scope'` once after updating. A fresh
   host has none.
8. **Agents share the host's ports and `/tmp`.** Two tenants' dev servers on `:5173` collide (the
   second one fails), and files an agent leaves world-readable in `/tmp` are readable by others.
   `hidepid` and private homes cover Tether's own state, not what agents choose to write.
9. **Never run a Tether dev stack on the shared host.** In dev mode the server treats every caller
   as the owner. It checks only the `Host` header, which any local user can set, and its runner
   token defaults to `dev`, so any other tenant could take it over. Use the local UI testing recipe
   on another machine. *Follow-up:* a random per-run dev secret.
10. **Every runner receives the app's VAPID private key.** Bob gets the key that signs Alice's
    pushes, but he can't use it without her subscription endpoints, which stay in her `push.json`
    (mode 600). This weakens defence in depth; *follow-up:* the server signs pushes.
11. **Tenants must hold only the viewer role on a shared app.** An editor, owner or org admin can
    edit `TETHER_RUNNER_OWNERS` or mint runner tokens. Prefer Foliation user ids (`sub`) over
    emails in the map. Emails are compared ASCII-only, so a non-ASCII lookalike never matches.
