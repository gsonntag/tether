// The runner's core, assembled: its event bus, ops, harness facts and connection to the app.
// index.ts adds modules and process handling; tests build one against a fake server.

import { defang } from "../../../shared/fromTether";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { CredentialStore, redact } from "../credentials";
import { CostLedger } from "../costs";
import type { SessionCost } from "../../../shared/costs";
import { testAzure } from "../adapters/codex/upstream";
import { PROTOCOL_VERSION, type HarnessInfo, type RunnerBuild, type RunnerInfo } from "../../../shared/protocol";
import { parseSessionId, sessionId } from "../../../shared/ids";
import type { ForkedFrom } from "../../../shared/fork";
import type { SessionPrefs } from "../config";
import { hasSourceModels, type BillingSource } from "../../../shared/credentials";
import type { Attachment } from "../../../shared/attachments";
import type { HarnessId, Msg, RequestAnswer } from "../../../shared/transcript";
import type { Adapter, StartOpts } from "./adapter";
import { RequestBroker, type PolicyStep } from "./broker";
import { EventBus } from "./bus";
import { Connection, type ConnectionOptions } from "./connection";
import { HubPort } from "./hubPort";
import type { CoreEvents } from "./events";
import { LiveControl } from "./live";
import { OpRegistry } from "./ops";
import { NoticeStore } from "./notices";
import { Prefs } from "./prefs";
import { readRunnerSettingsFrom } from "./runnerSettings";
import { cleanRunnerName, type WorktreeRecord } from "../config";
import { registerSessionOps } from "./sessionOps";
import { registerShellOps, ShellRuns, type SetupRun } from "./shellRuns";
import type { Session } from "./session";
import { chosenOf, SessionCore } from "./sessions";
import type { SpawnPty } from "../terminal/attach";
import { TerminalControl } from "../terminal/control";
import { registerTerminalOps } from "../terminal/ops";
import { systemdScopeWrap, Tmux, TMUX_SOCKET } from "../terminal/tmux";

export interface RunnerOptions {
  costsFile?: string;
  credentials?: CredentialStore;
  url: string;
  token: string;
  runnerId: string;
  name: string;
  /** the name a blank rename goes back to (the hostname, or a friendly one); `name` when absent */
  defaultName?: string;
  version: string;
  /** git build stamp read at startup; absent outside a git checkout or on fallback */
  build?: RunnerBuild;
  /** periodically re-reads the git build stamp (commit, behind, dirty) */
  detectBuild?: () => Promise<RunnerBuild | undefined>;
  /** how often to check for git build stamp changes; defaults to 1 hour */
  buildCheckMs?: number;
  detectHarnesses: () => Promise<HarnessInfo[]>;
  /** how often to look for installed or removed harnesses */
  harnessCheckMs?: number;
  log?: (line: string) => void;
  /** connection tuning, for tests */
  connection?: Partial<ConnectionOptions>;
  /** the harnesses this runner can drive (SPEC §6) */
  adapters?: Adapter[];
  /** where per-session settings are kept (runner.json); tests pass a temp file */
  prefsFile?: string;
  /** where Tether's own notices are kept (CONFIG_DIR/notices.json); in memory when absent */
  noticesFile?: string;
  /** where attachments are stored (CONFIG_DIR/attachments); tests pass a temp folder */
  attachmentsDir?: string;
  /** the request broker's policy steps (SPEC §7); none in the core */
  policy?: PolicyStep[];
  /** session core tuning, for tests */
  core?: { discoverMs?: number; evictMs?: number; idleMs?: number; hideProjects?: string; maxLive?: number };
  /**
   * Terminal mode (SPEC §8): Tether's tmux and where hooks report. index.ts turns it on (tmux on
   * TMUX_SOCKET, when installed); absent or false, the runner has no terminals (tests).
   */
  terminal?: false | { tmux?: Tmux; hookSocket?: string | null; spawn?: SpawnPty; pollMs?: number; quitTimeoutMs?: number; shell?: string };
}

export function createRunner(o: RunnerOptions) {
  const originalLog = o.log ?? ((line: string) => console.log(line));
  o = { ...o, log: (line) => originalLog(redact(line)) };
  const bus = new EventBus<CoreEvents>();
  const ops = new OpRegistry();
  /** this process's summary epoch (protocol.ts SummaryUpdate): a restart starts browsers' lists over */
  const epoch = crypto.randomUUID();

  ops.register("ping", () => ({ runnerId: o.runnerId, at: Date.now() }));

  let harnesses = o.detectHarnesses();
  let name = o.name;
  let currentBuild: RunnerBuild | undefined = o.build;
  const helloInfo = async (): Promise<Omit<RunnerInfo, "connectedAt">> => ({
    id: o.runnerId,
    name,
    hostname: hostname(),
    version: o.version,
    ...(currentBuild ? { build: currentBuild } : {}),
    protocol: PROTOCOL_VERSION,
    harnesses: await harnesses,
    git: true,
    gitActions: true,
    files: true,
    pinning: true,
    // The peers module's op (off with it).
    ...(process.env.TETHER_PEERS === "0" ? {} : { spawnedFamily: true }),
    existingWorktrees: true,
    archiveWorktree: true,
    canText: true,
    // The relay shows the runner to these people (shared/access.ts) and only its owners see the list.
    ...(prefs.shared().length ? { shared: prefs.shared() } : {}),
    ...(hubPort.state ? { textingHub: hubPort.state } : {}),
  });

  const conn = new Connection({
    url: o.url,
    token: o.token,
    log: o.log,
    hello: helloInfo,
    onRpc: (op, args) => ops.handle(op, args),
    onDetach: (ids) => terminal?.detach(ids),
    onUnwatched: (sessionIds) => bus.emit("unwatched", { sessionIds }),
    // The server forgot every route with the old connection, so after a reconnect nobody watches
    // anything until browsers subscribe again: the core stops tails on `disconnected`.
    onState: (connected, push) => (connected ? bus.emit("connected", { push }) : bus.emit("disconnected", {})),
    onViewers: (sessions) => bus.emit("viewers", { sessions }),
    onTextHub: (hub) => hubPort.gotHub(hub),
    onTexting: (from, m) => hubPort.gotFrame(from, m),
    ...o.connection,
  });
  // The server forgets this runner's hub with the connection; it says again after the next hello.
  bus.on("disconnected", () => hubPort.gotHub(null));

  const hubPort: HubPort = new HubPort(
    (m) => conn.send(m),
    () => conn.buffered(),
    () => void helloInfo().then((runner) => conn.send({ t: "hello", runner })),
  );
  const prefs = new Prefs(o.prefsFile);
  readRunnerSettingsFrom(() => prefs.settings());
  const costs = new CostLedger(o.costsFile);
  const core = new SessionCore({
    costs,
    adapters: o.adapters ?? [],
    bus,
    send: (m) => conn.send(m),
    epoch,
    prefs,
    notices: o.noticesFile ? new NoticeStore(o.noticesFile) : undefined,
    log: o.log,
    discoverMs: o.core?.discoverMs,
    evictMs: o.core?.evictMs,
    hideProjects: o.core?.hideProjects,
  });
  // Open requests are kept in runner.json, so they survive a restart (SPEC §7).
  const broker = new RequestBroker(o.policy, { saved: prefs.requests(), closed: prefs.closedRequests(), persist: (open, closed) => prefs.setRequests(open, closed), log: o.log });
  const live = new LiveControl(core, broker, { idleMs: o.core?.idleMs, maxLive: o.core?.maxLive, attachmentsDir: o.attachmentsDir, credentials: o.credentials, costs });
  ops.register("fallbackSetup", (a) => live.fallbackSetup(a.sessionId));
  ops.register("setFallbackChain", (a) => live.setFallbackChain(a.sessionId, a.enabled, a.steps, a.continueOnReset));
  ops.register("editFallbackPreset", (a) => live.editFallbackPreset(a));
  if (o.credentials) {
    ops.register("credentials", () => o.credentials!.status());
    ops.register("setCredential", (a) => { const result = o.credentials!.set(a.source, a.key, a.endpoint, a.deployment, a.rates); live.credentialsChanged(); return result; });
    ops.register("unsetCredential", (a) => { const result = o.credentials!.unset(a.source); live.credentialsChanged(); return result; });
    ops.register("setBedrock", (a) => { const result = o.credentials!.setBedrock(a); live.credentialsChanged(); return result; });
    ops.register("setAzure", (a) => { const result = o.credentials!.setAzure({ endpoint: a.endpoint, deployments: a.deployments }); live.credentialsChanged(); return result; });
    ops.register("testAzure", (a) => testAzure(o.credentials!.snapshot("azure", typeof a.deployment === "string" ? a.deployment : "")));
    ops.register("billingSources", (a) => live.sources(a.harness));
    ops.register("refreshPlan", async (a) => { await core.refreshPlan(a.harness); return null; });
    ops.register("setSessionSource", async (a) => { await live.setSource(String(a.sessionId ?? ""), a.source); return null; });
  }
  ops.register("runnerSettings", () => prefs.settings());
  ops.register("setRunnerSettings", (a) => prefs.setSettings({ ...(typeof a?.backgroundSubagents === "boolean" ? { backgroundSubagents: a.backgroundSubagents } : {}), ...(typeof a?.conciseReplies === "boolean" ? { conciseReplies: a.conciseReplies } : {}) }));
  ops.register("setRunnerName", async (a) => {
    const typed = cleanRunnerName(a?.name);
    prefs.setName(typed);
    name = typed || o.defaultName || o.name;
    // A repeated hello on the same connection just updates what the browsers see.
    conn.send({ t: "hello", runner: await helloInfo() });
    return { name };
  });
  // Owners only: the relay refuses it from anyone else (shared/access.ts MANAGE_OPS).
  ops.register("setRunnerAccess", async (a) => {
    const people = prefs.setShared(a?.people);
    conn.send({ t: "hello", runner: await helloInfo() });
    return { people };
  });
  registerSessionOps(ops, core, live);
  const shellRuns = new ShellRuns(core, live, { shell: (o.terminal || undefined)?.shell });
  registerShellOps(ops, shellRuns);
  const t = o.terminal || undefined;
  const terminal =
    t && (t.tmux || Bun.which("tmux"))
      ? new TerminalControl({
          core,
          live,
          tmux: t.tmux ?? new Tmux({ wrapStart: systemdScopeWrap(TMUX_SOCKET) }),
          send: (m) => conn.send(m),
          buffered: () => conn.buffered(),
          hookSocket: t.hookSocket ?? null,
          spawn: t.spawn,
          pollMs: t.pollMs,
          quitTimeoutMs: t.quitTimeoutMs,
          shell: t.shell,
          log: o.log,
        })
      : undefined;
  registerTerminalOps(ops, terminal);

  /** how to fork (modules/index.ts ForkOptions) */
  type ForkOptions = { messageId?: string; permissionMode?: string; title?: string; sideOf?: string };
  /** the fork module's (SPEC §16): the core only passes calls on */
  let forker: ((id: string, o: ForkOptions) => Promise<string>) | undefined;

  const lookAt = (s: Session) => ({
    summary: s.summary,
    status: s.state.status,
    requests: s.state.requests.map((r) => r.id),
    state: s.state,
    busy: s.shellsRunning > 0 || s.childRunning || !!s.sending || !!s.starting || !!s.state.backgroundSubagents || !!s.state.watching?.length,
    background: !!s.driver?.busy(),
  });

  const timer = setInterval(async () => {
    const before = JSON.stringify(await harnesses);
    harnesses = o.detectHarnesses();
    // A repeated hello on the same connection just updates what the browsers see.
    if (JSON.stringify(await harnesses) !== before) conn.send({ t: "hello", runner: await helloInfo() });
  }, o.harnessCheckMs ?? 60_000);
  timer.unref?.();

  if (o.detectBuild) {
    // Refresh at startup and hourly; re-send hello when build changes.
    const refreshBuild = async () => {
      const before = JSON.stringify(currentBuild);
      // A failed read (git busy, offline) keeps what was known.
      const next = await o.detectBuild!().catch(() => undefined);
      if (next && JSON.stringify(next) !== before) {
        currentBuild = next;
        conn.send({ t: "hello", runner: await helloInfo() });
      }
    };
    void refreshBuild();
    const buildTimer = setInterval(refreshBuild, o.buildCheckMs ?? 3_600_000);
    buildTimer.unref?.();
  }

  return {
    bus,
    ops,
    conn,
    epoch,
    core,
    live,
    shellRuns,
    harnesses: () => harnesses,
    terminal,
    /** what modules may know about sessions (modules/index.ts ModuleContext) */
    look: {
      session: (id: string) => {
        const s = core.sessions.get(id);
        return s ? lookAt(s) : undefined;
      },
      loaded: () => [...core.sessions.values()].map(lookAt),
      // From runner.json, not the lists (they hold only recent sessions, and none until discovery).
      texters: () =>
        prefs
          .texters()
          .map((id) => {
            const row = core.sessions.get(id)?.summary ?? core.book.get(id);
            return { id, title: prefs.get(id).title ?? row?.title ?? "", at: row?.updatedAt ?? prefs.get(id).at ?? 0 };
          })
          .sort((a, b) => b.at - a.at)
          .map(({ id, title }) => ({ id, title })),
      viewersOf: (id: string) => live.read.viewersOf(id),
      apiCost: (id: string) => (costs.has(id) || prefs.get(id).metered ? costs.get(id) : undefined),
      hiddenFolder: (path: string) => core.hidden(path),
      hub: hubPort,
      sessions: {
        adapters: () => o.adapters ?? [],
        open: async (id: string) => lookAt(await core.open(id)),
        adopt: async (harness: HarnessId, nativeId: string, projectPath: string, opts: StartOpts, source: BillingSource, from?: string, extra: { stored?: boolean; forkedFrom?: ForkedFrom; keys?: Pick<SessionPrefs, "lastKey">; sideOf?: string; fresh?: boolean } = {}) => {
          const id = sessionId(harness, nativeId);
          opts = live.forSource(harness, source, opts);
          core.o.prefs.set(id, { projectPath, ...chosenOf(core.adapter(harness), opts), source, ...(hasSourceModels(source) && opts.model ? { deployment: opts.model } : {}), ...(from ? { carrying: true } : {}), ...(extra.forkedFrom ? { forkedFrom: extra.forkedFrom } : {}), ...extra.keys, ...(extra.sideOf ? { sideOf: extra.sideOf } : {}) });
          for (const n of from ? core.notices.get(from) : []) core.notices.add(id, n);
          // A new session on a key (a Move, or a source change's new thread), metered from its first
          // request: what it brought across was spent elsewhere, and a carry adds that (live.ts
          // carryCost). Resuming the imported history doesn't mean unknown earlier usage here.
          if (source !== "subscription") {
            try { live.beginCost(id, true); } catch { core.log("Couldn't save this session's API cost coverage. Its total is unknown."); }
          }
          const s = extra.fresh ? core.create(harness, nativeId, projectPath, opts) : await core.open(id);
          core.book.upsert([s.summary]);
          if (from) {
            // A source change: nothing is anyone's until the harness has confirmed it.
            try { await live.resumeLive(s); }
            catch (e) { core.dropFresh(s); throw e; }
            return id;
          }
          // A fork: its source is the original's, already confirmed there. Nothing starts until its first send.
          if (extra.stored) return id;
          // A failure (a key refused, a source it can't confirm) stays on the session: nothing falls back.
          await live.resumeLive(s).catch(() => {});
          return id;
        },
        // Not started: its first send does that, after whatever the module sets up for it.
        create: async ({ harness, projectPath, source, ...opts }: { harness: HarnessId; projectPath: string; source: BillingSource } & StartOpts) => {
          const s = await live.createSession(harness, core.folder(projectPath), opts, source);
          core.touch(s);
          return s.id;
        },
        newId: (harness: HarnessId, projectPath: string, opts: StartOpts, source: BillingSource) => live.newNativeId(harness, projectPath, opts, source),
        sources: (harness: HarnessId) => live.sources(harness),
        sourceOf: async (id: string) => live.sourceOf(await core.open(id)),
        sourceForNew: (harness: HarnessId, source: unknown) => live.sourceForNew(harness, source),
        send: (id: string, text: string) => live.send(id, text, [], { tether: true }),
        tell: (id: string, text: string, attachments: Attachment[] = []) => (live.attachments.markUsed(attachments), live.tell(id, defang(text), attachments)),
        answer: (id: string, requestId: string, a: RequestAnswer) =>
          live.answerRequest(id, requestId, a.allow ? { ...a, ...(a.notes ? { notes: defang(a.notes) } : {}) } : { allow: false, ...(a.reason ? { reason: defang(a.reason) } : {}) }),
        carrier: (f: NonNullable<LiveControl["carrier"]>) => { live.carrier = f; },
        fallbackMover: (f: NonNullable<LiveControl["fallbackMover"]>) => { live.fallbackMover = f; },
        fallbackArchiver: (f: NonNullable<LiveControl["fallbackArchive"]>) => { live.fallbackArchive = f; },
        fork: (id: string, f: ForkOptions = {}) => (forker ? forker(id, f) : Promise.reject(new Error("This runner can't fork sessions."))),
        forker: (f: (id: string, o: ForkOptions) => Promise<string>) => { forker = f; },
        moveSides: (from: string, to: string) => core.moveSides(from, to),
        sideChatsOf: (id: string) => core.o.prefs.sideChatsOf(id),
        closeDriver: async (id: string) => {
          const s = core.sessions.get(id);
          if (s) await live.release(s);
        },
        kept: (id: string) => {
          const p = core.o.prefs.get(id);
          return { ...(p.archived ? { archived: true } : {}), ...(p.movedTo ? { movedTo: p.movedTo } : {}) };
        },
        projects: () => core.listProjects(),
        // Side chats (SPEC §16a) aren't in the lists: they show under their session.
        list: () => core.listed().filter((r) => !r.sideOf),
        archived: async () => (await core.listSessions({ archived: true, limit: 2000 })).sessions,
        all: async () => (await core.listSessions({ all: true, limit: 2000 })).sessions.filter((r) => !r.sideOf),
        storeFile: async (id: string, projectPath: string) => {
          const parsed = parseSessionId(id);
          const adapter = parsed && core.o.adapters.find((a) => a.id === parsed.harness);
          return adapter?.storeFile ? adapter.storeFile(parsed!.nativeId, projectPath).catch(() => undefined) : undefined;
        },
        folder: (path: string) => core.folder(path),
        ask: async (id: string, prompt: string, opts: { system: string; timeoutMs: number }) => {
          const s = await core.open(id);
          const adapter = core.adapter(s.summary.harness);
          if (!adapter.ask) throw new Error("This session's harness can't generate text.");
          // The session's own source, as its next start would use it: a missing key stops here.
          const credential = live.credentialFor(s.summary.harness, live.sourceOf(s), live.deploymentOf(s));
          // On a key, what it cost goes in the session's API ledger with its turns'.
          const onCost = credential && credential.source !== "subscription" ? (c: SessionCost) => void live.sideCost(s.id, c) : undefined;
          return adapter.ask(s.summary.projectPath, prompt, { ...opts, ...(credential ? { credential } : {}), ...(onCost ? { onCost } : {}) });
        },
        holdFolder: (folder: string, why: string) => live.holdFolder(folder, why),
        heldWhy: (id: string) => live.heldWhy(id),
        queue: (id: string, text: string, attachments: Attachment[] = []) => (live.attachments.markUsed(attachments), live.queue.add(id, text, attachments)),
        handOverQueue: (from: string, to: string) => live.queue.handOver(from, to),
        recent: async (id: string, limit: number) => {
          const s = await core.open(id);
          return (await core.load(s)).newest(limit).messages;
        },
        rename: async (id: string, title: string) => {
          const s = await core.open(id);
          core.o.prefs.set(s.id, { title });
          core.o.prefs.flush();
          core.touch(s, { title });
        },
        interrupt: (id: string) => live.interrupt(id),
        setArchived: async (id: string, archived: boolean) => void (await core.setArchived(await core.open(id), archived)),
        setWorktree: async (id: string, worktree: WorktreeRecord) => core.setWorktree(await core.open(id), worktree),
        worktree: (id: string) => prefs.get(id).worktree,
        // A session that went on under another id (a source change, a renewal) isn't one: its successor has the record.
        worktreeUsers: (path?: string) =>
          prefs
            .ids((p) => !p.carried && !p.movedTo && !!p.worktree && (path === undefined || resolve(p.worktree.path) === resolve(path)))
            .map((id) => ({ id, worktree: prefs.get(id).worktree!, ...(prefs.get(id).archived ? { archived: true } : {}) })),
        setup: async (id: string, command: string, { beforeRelease, ...run }: Omit<SetupRun, "done"> & { beforeRelease?: () => void | Promise<void> } = {}) => {
          const s = await core.open(id);
          live.queue.setupStarted(s);
          let settle!: (v: { ok: boolean; why: string }) => void;
          const done = new Promise<{ ok: boolean; why: string }>((r) => (settle = r));
          const end = async (ok: boolean, why: string) => {
            // What the setup left, taken before anything waiting can reach the agent (the gate holds until then).
            await Promise.resolve(beforeRelease?.()).catch(() => {});
            live.queue.setupEnded(s, ok);
            // Home shows it as needing you, whether or not anything waits.
            if (!ok) live.read.set(s.id, { failure: `${why} What you send waits: re-run the setup, or send anyway.` });
            settle({ ok, why });
          };
          await shellRuns.run(id, command, { ...run, done: (ok, why) => void end(ok, why) }).catch((e) => end(false, `The worktree's setup couldn't start: ${(e as Error).message}`));
          return { done };
        },
        notice: async (id: string, msg: Msg, where: { first?: boolean; after?: string } = {}) => {
          const s = core.sessions.get(id);
          // Not read yet: it joins what the store has when it's read.
          if (!s?.transcript) {
            core.notices.add(id, { msg, ...where });
            if (s) s.overlay = core.notices.get(id);
            return;
          }
          s.apply({ type: "msg", msg });
          const n = s.overlay.find((x) => x.msg.id === msg.id);
          if (n && (where.first || where.after)) {
            n.first = where.first;
            n.after = where.after;
            core.notices.set(id, s.overlay);
          }
        },
      },
    },
    start: async () => {
      core.startDiscovery();
      if (o.attachmentsDir) live.attachments.startHousekeeping();
      void live.desk.restore();
      const rejoined = live.rejoin();
      // Before connecting, so the first summary already shows readopted terminals.
      await terminal?.start();
      // Queues come back after the sessions that kept running are joined again and the TUIs are
      // readopted (a queue held for a terminal that is gone must not wait for it).
      // A worktree setup a restart cut off: failed, so what's sent waits for Re-run setup or Send anyway.
      for (const id of live.queue.setupsCutOff()) live.read.set(id, { failure: "The worktree's setup was cut off by a runner restart. What you send waits: re-run the setup, or send anyway." });
      void rejoined.finally(async () => { await live.restoreRetries(); await live.queue.restore(); live.restoreFallbackTimers(); });
      conn.start();
    },
    /** Closes live sessions (their harnesses flush), then the connection. */
    stop: async () => {
      clearInterval(timer);
      // Before the notices are written for the last time: their cards end as not sent (and their
      // process groups get SIGKILL 2 s on, waited for at the end).
      const shells = shellRuns.stopAll();
      terminal?.stop();
      core.stop();
      live.attachments.stop();
      await live.closeAll().catch(() => {});
      core.o.prefs.flush();
      conn.stop();
      await shells;
    },
  };
}
