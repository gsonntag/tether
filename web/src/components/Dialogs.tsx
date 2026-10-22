import { Children, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Divider } from "@astryxdesign/core/Divider";
import { Field } from "@astryxdesign/core/Field";
import { HStack } from "@astryxdesign/core/HStack";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector, type SelectorOptionType } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Stack, StackItem } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import {
  formatEntry,
  GUARD_MODES,
  HARNESSES,
  LEADER_UPDATES,
  NOTIFY_KINDS,
  parseEntry,
  SIDEBAR_DAYS,
  type BackgroundModelSetting,
  type GuardMode,
  type HarnessId,
  type LeaderUpdates,
  type ModelProfile,
  type NotifyKind,
  type Ops,
  type ProjectInfo,
  type SecretView,
} from "../shared/protocol";
import { profileProblems, profilesToSave } from "../shared/profiles";
import { disablePush, enablePush, needsHomeScreen, pushState, pushSupported, testPush } from "../push";

import { act, refreshProjects, rpc, selectSession, setUiPref, toast, toggleProject, useStore } from "../store";
import { addModeOf, filterRepos, isMissing, isOldRunner, type AddMode } from "../addProject";
import { sidebarDaysLabel } from "../recentSessions";
import { tildify } from "../util";
import { ChainEditor } from "./ChainEditor";
import { useModels } from "./ModelMenu";
import { chainLabel, modelDisplay } from "../models";
import { modelIcon } from "./ModelName";

/** Modal host; the Dialog handles Escape and backdrop clicks. */
export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const close = () => useStore.setState({ dialog: undefined });
  return (
    <Dialog isOpen={!!dialog} onOpenChange={(o) => !o && close()} purpose="info" width={560} maxHeight="90dvh">
      {dialog === "new" && <NewSession close={close} />}
      {dialog === "addProject" && <AddProject close={close} />}
      {dialog === "settings" && <Settings close={close} />}
      {dialog === "fork" && <ForkSession close={close} />}
      {dialog === "leader" && <StartLeader close={close} />}
    </Dialog>
  );
}

/** Header / scrolling body / end-aligned action row, shared by every dialog. `fill` caps the layout at the dialog's max height so the body scrolls instead of being clipped. */
function Frame({ title, subtitle, close, actions, children }: { title: string; subtitle?: ReactNode; close: () => void; actions: ReactNode; children?: ReactNode }) {
  return (
    <Layout
      height="fill"
      header={<DialogHeader title={title} subtitle={subtitle} onOpenChange={(o) => !o && close()} />}
      content={
        children ? (
          <LayoutContent>
            <VStack gap={4}>{children}</VStack>
          </LayoutContent>
        ) : undefined
      }
      footer={
        <LayoutFooter hasDivider>
          <HStack gap={2} hAlign="end" wrap="wrap">
            {actions}
          </HStack>
        </LayoutFooter>
      }
    />
  );
}

/** A visible label over a control that only carries an aria-label (SegmentedControl, ToggleButtonGroup). */
function Group({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  const id = useId();
  return (
    <Field label={label} description={description} inputID={id} isGroupLabel>
      {children}
    </Field>
  );
}

type Last = { choice: string; guard?: GuardMode };

function loadLast(harness: HarnessId): Last | undefined {
  try {
    const raw = localStorage.getItem(`tether.last.${harness}`);
    if (raw) return JSON.parse(raw);
  } catch {}
  const choice = localStorage.getItem(`tether.model.${harness}`);
  if (choice === null) return undefined;
  return { choice, guard: (localStorage.getItem("tether.guard") as GuardMode) || undefined };
}

const choiceLabel = (c: string) => (c.startsWith("profile:") ? c.slice(8) : modelDisplay(c || undefined).name);

/** Selector values can't be empty; the harness default ("") travels as this sentinel. */
const DEFAULT_CHOICE = "__default__";
const ADD_PROJECT = "+add";

function NewSession({ close }: { close: () => void }) {
  const allProjects = useStore((s) => s.projects);
  const runner = useStore((s) => s.runners.find((r) => r.id === s.runnerId));
  const initial = useStore((s) => s.newSessionProject);
  const projects = allProjects.filter((p) => !p.archived || p.path === initial);
  const [project, setProject] = useState(initial ?? projects[0]?.path ?? "");
  const [harness, setHarness] = useState<HarnessId>(() => (localStorage.getItem("tether.harness") as HarnessId) || "claude-code");
  const last = useMemo(() => loadLast(harness), [harness]);
  const [choice, setChoice] = useState("last"); // "last" | "" (harness default) | model id | profile:<name>
  const [guard, setGuard] = useState<GuardMode>(() => last?.guard ?? "auto");
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const models = useModels([harness]);
  useEffect(() => {
    rpc("getProfiles", {}).then(setProfiles).catch(() => {});
  }, []);
  useEffect(() => {
    setChoice("last");
    if (last?.guard) setGuard(last.guard);
  }, [last]);
  const available = HARNESSES.filter((h) => !runner || runner.harnesses.includes(h.id));
  const fixedProject = initial ? allProjects.find((p) => p.path === initial) : undefined;
  const guardLabel = (g?: GuardMode) => GUARD_MODES.find((m) => m.id === g)?.label;

  const start = async () => {
    if (!project || busy) return;
    setBusy(true);
    const picked: Last = choice === "last" ? (last ?? { choice: "" }) : { choice, guard };
    localStorage.setItem("tether.harness", harness);
    localStorage.setItem(`tether.last.${harness}`, JSON.stringify(picked));
    const isProfile = picked.choice.startsWith("profile:");
    const s = await act("createSession", {
      projectPath: project,
      harness,
      model: !isProfile && picked.choice ? picked.choice : undefined,
      profile: isProfile ? picked.choice.slice(8) : undefined,
      // Claude Code's own mode would override the guard (its settings can set acceptEdits, plan, …).
      permissionMode: harness === "claude-code" && picked.guard ? "default" : undefined,
      guard: picked.guard,
      prompt: prompt.trim() || undefined,
    });
    setBusy(false);
    if (!s) return;
    if (name.trim()) act("renameSession", { sessionId: s.id, projectPath: s.projectPath, title: name });
    close();
    toggleProject(project, true);
    selectSession(s.id);
  };
  // ⌘/Ctrl+Enter starts the session from anywhere in the dialog (a menu that's open keeps its Enter).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.defaultPrevented) return;
      e.preventDefault();
      start();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const projectOptions: SelectorOptionType[] = [
    ...projects.map((p) => ({ value: p.path, label: `${p.name} — ${tildify(p.path)}` })),
    { type: "divider" },
    { value: ADD_PROJECT, label: "Add a project…" },
  ];
  const modelOptions: SelectorOptionType[] = [
    { value: "last", label: `Use last${last ? ` (${choiceLabel(last.choice)}${last.guard ? ` · ${guardLabel(last.guard)}` : ""})` : ""}` },
    { value: DEFAULT_CHOICE, label: "Default" },
    ...(profiles.length > 0
      ? [{ type: "section" as const, title: "Fallback profiles", options: profiles.map((p) => ({ value: `profile:${p.name}`, label: `${p.name}: ${chainLabel(p.chain, harness)}` })) }]
      : []),
    {
      type: "section",
      title: "Models",
      options: (models[harness] ?? []).map((m) => {
        const d = modelDisplay(m.id, harness);
        return { value: m.id, label: d.name, description: m.id, icon: modelIcon(d) };
      }),
    },
  ];

  return (
    <Frame
      title={fixedProject ? `New session in ${fixedProject.name}` : "New session"}
      close={close}
      actions={
        <>
          <Button label="Cancel" onClick={close} />
          <Button label="Start session" variant="primary" tooltip="⌘↵" isDisabled={!project} isLoading={busy} onClick={start} />
        </>
      }
    >
      {!fixedProject && (
        <Selector
          label="Project"
          width="100%"
          options={projectOptions}
          value={project || undefined}
          onChange={(v) => (v === ADD_PROJECT ? useStore.setState({ dialog: "addProject" }) : setProject(v))}
        />
      )}
      <Group label="Harness">
        <SegmentedControl label="Harness" value={harness} onChange={(v) => setHarness(v as HarnessId)}>
          {available.map((h) => (
            <SegmentedControlItem key={h.id} value={h.id} label={h.label} />
          ))}
        </SegmentedControl>
      </Group>
      <Selector
        label="Model"
        width="100%"
        hasSearch
        options={modelOptions}
        value={choice === "" ? DEFAULT_CHOICE : choice}
        onChange={(v) => setChoice(v === DEFAULT_CHOICE ? "" : v)}
      />
      {choice !== "last" && (
        <Group label="Permissions">
          <SegmentedControl label="Permissions" value={guard} onChange={(v) => setGuard(v as GuardMode)}>
            {GUARD_MODES.map((g) => (
              <SegmentedControlItem key={g.id} value={g.id} label={g.label} />
            ))}
          </SegmentedControl>
        </Group>
      )}
      <TextInput label="Name" value={name} onChange={setName} placeholder="Optional: named from the first message otherwise" />
      <TextArea label="First message" rows={4} value={prompt} onChange={setPrompt} placeholder="What should the agent do? (⌘↵ to start)" />
    </Frame>
  );
}

/**
 * "Fork from here": a new session with the conversation up to the picked message, on any harness
 * and model. On one of your messages the new session answers it again (with anything added here).
 */
function ForkSession({ close }: { close: () => void }) {
  const target = useStore((s) => s.forkTarget);
  const runner = useStore((s) => s.runners.find((r) => r.id === s.runnerId));
  const [harness, setHarness] = useState<HarnessId>(target?.harness ?? "claude-code");
  const [model, setModel] = useState(target?.model ?? "");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const models = useModels([harness]);
  if (!target) return null;
  const available = HARNESSES.filter((h) => !runner || runner.harnesses.includes(h.id));
  const pickHarness = (h: HarnessId) => {
    setHarness(h);
    setModel(h === target.harness ? (target.model ?? "") : "");
  };
  const listed = models[harness] ?? [];
  const modelOptions: SelectorOptionType[] = [
    { value: DEFAULT_CHOICE, label: "Default" },
    ...listed
      .filter((m) => m.id !== "default")
      .map((m) => {
        const d = modelDisplay(m.id, harness);
        return { value: m.id, label: d.name, description: m.id, icon: modelIcon(d) };
      }),
    // The session's own model, even when the list doesn't have it (an alias).
    ...(model && !listed.some((m) => m.id === model) ? [{ value: model, label: modelDisplay(model, harness).name, description: model }] : []),
  ];
  const fork = async () => {
    if (busy) return;
    setBusy(true);
    const s = await act("forkSession", { sessionId: target.sessionId, msgId: target.msgId, harness, model: model || undefined, prompt: prompt.trim() || undefined });
    setBusy(false);
    if (!s) return;
    close();
    selectSession(s.id);
  };
  const at = target.excerpt ? `“${target.excerpt}”` : target.atUser ? "your message" : "this reply";
  return (
    <Frame
      title="Fork from here"
      subtitle={target.atUser ? `A new session with the conversation before ${at}, which it answers again.` : `A new session with the conversation up to ${at}.`}
      close={close}
      actions={
        <>
          <Button label="Cancel" onClick={close} />
          <Button label="Fork" variant="primary" isLoading={busy} onClick={fork} />
        </>
      }
    >
      <Group label="Harness">
        <SegmentedControl label="Harness" value={harness} onChange={(v) => pickHarness(v as HarnessId)}>
          {available.map((h) => (
            <SegmentedControlItem key={h.id} value={h.id} label={h.label} />
          ))}
        </SegmentedControl>
      </Group>
      <Selector label="Model" width="100%" hasSearch options={modelOptions} value={model || DEFAULT_CHOICE} onChange={(v) => setModel(v === DEFAULT_CHOICE ? "" : v)} />
      <VStack onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && fork()}>
        <TextArea
          label={target.atUser ? "Add to your message" : "First message"}
          rows={3}
          value={prompt}
          onChange={setPrompt}
          placeholder={target.atUser ? "Optional" : "Optional: without one, the agent catches up and waits for you"}
        />
      </VStack>
    </Frame>
  );
}

/**
 * "Start your leader": the runner's leader agent (runner/src/leader.ts), on any harness and model.
 * It starts on your last New session choice for that harness.
 */
function StartLeader({ close }: { close: () => void }) {
  const runner = useStore((s) => s.runners.find((r) => r.id === s.runnerId));
  // Antigravity gets Tether's tools from its global config, without the leader's.
  const available = HARNESSES.filter((h) => h.id !== "antigravity" && (!runner || runner.harnesses.includes(h.id)));
  const [harness, setHarness] = useState<HarnessId>(() => {
    const last = localStorage.getItem("tether.harness") as HarnessId | null;
    return last && available.some((h) => h.id === last) ? last : (available[0]?.id ?? "claude-code");
  });
  const last = useMemo(() => loadLast(harness)?.choice, [harness]);
  const [model, setModel] = useState("");
  useEffect(() => setModel(last && !last.startsWith("profile:") ? last : ""), [last]);
  const [busy, setBusy] = useState(false);
  const models = useModels([harness]);
  const listed = (models[harness] ?? []).filter((m) => m.id !== "default");
  const modelOptions: SelectorOptionType[] = [
    { value: DEFAULT_CHOICE, label: "Default" },
    ...listed.map((m) => {
      const d = modelDisplay(m.id, harness);
      return { value: m.id, label: d.name, description: m.id, icon: modelIcon(d) };
    }),
    ...(model && !listed.some((m) => m.id === model) ? [{ value: model, label: modelDisplay(model, harness).name, description: model }] : []),
  ];
  const start = async () => {
    if (busy) return;
    setBusy(true);
    const s = await act("createLeader", { harness, model: model || undefined });
    setBusy(false);
    if (!s) return;
    close();
    selectSession(s.id);
  };
  return (
    <Frame
      title="Start your leader"
      subtitle="One agent that follows every session on this runner: ask it where things are at, and tell it what to pass on. It acts only on what you tell it, and tool approvals stay your click."
      close={close}
      actions={
        <>
          <Button label="Cancel" onClick={close} />
          <Button label="Start your leader" variant="primary" isLoading={busy} onClick={start} />
        </>
      }
    >
      <Group label="Harness">
        <SegmentedControl label="Harness" value={harness} onChange={(v) => setHarness(v as HarnessId)}>
          {available.map((h) => (
            <SegmentedControlItem key={h.id} value={h.id} label={h.label} />
          ))}
        </SegmentedControl>
      </Group>
      <Selector label="Model" width="100%" hasSearch options={modelOptions} value={model || DEFAULT_CHOICE} onChange={(v) => setModel(v === DEFAULT_CHOICE ? "" : v)} />
    </Frame>
  );
}

type GithubRepo = Ops["githubRepos"]["result"][number];
const DEFAULT_PARENT = "~/projects";

function AddProject({ close }: { close: () => void }) {
  const [mode, setMode] = useState<AddMode>(() => addModeOf(localStorage.getItem("tether.addMode")));
  const narrow = useMediaQuery(NARROW);
  const [path, setPath] = useState("~");
  const [dirs, setDirs] = useState<string[]>([]);
  const [cwd, setCwd] = useState("");
  /** where new projects and clones go: remembered per device */
  const [parent, setParent] = useState(() => localStorage.getItem("tether.projectParent") || DEFAULT_PARENT);
  const [missing, setMissing] = useState(false);
  /** Opens p below and returns where that is; false: it doesn't exist (Add then offers to create it); undefined: some other failure, toasted. */
  const browse = async (p: string): Promise<string | false | undefined> => {
    try {
      const r = await rpc("listDirs", { path: p });
      setCwd(r.path);
      setPath(r.path);
      setDirs(r.dirs);
      setMissing(false);
      return r.path;
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (!isMissing(msg)) return void toast("error", msg);
      setMissing(true);
      setCwd("");
      setDirs([]);
      return false;
    }
  };
  useEffect(() => {
    browse("~");
  }, []);
  const [account, setAccount] = useState<Ops["githubAccount"]["result"]>();
  const [oldRunner, setOldRunner] = useState(false);
  useEffect(() => {
    // An older runner doesn't know it, or gh isn't logged in: no GitHub options.
    rpc("githubAccount", {})
      .then(setAccount)
      .catch((e) => (setAccount(null), setOldRunner(isOldRunner(e?.message ?? ""))));
  }, []);

  const [name, setName] = useState("");
  const [github, setGithub] = useState(true);
  const [owner, setOwner] = useState("");
  const [isPrivate, setPrivate] = useState(true);
  const [repo, setRepo] = useState("");
  /** per owner, loaded on first look */
  const [repos, setRepos] = useState<Record<string, GithubRepo[] | "loading" | "failed">>({});
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const listOwner = owner || account?.login || "";
  useEffect(() => {
    if (mode !== "clone" || !account || repos[listOwner]) return;
    const put = (r: GithubRepo[] | "loading" | "failed") => setRepos((m) => ({ ...m, [listOwner]: r }));
    put("loading");
    rpc("githubRepos", { owner: listOwner === account.login ? undefined : listOwner }).then(put, () => put("failed"));
  }, [mode, account, listOwner, repos]);

  const pickMode = (m: AddMode) => (setMode(m), localStorage.setItem("tether.addMode", m));
  const opened = async (p: ProjectInfo | undefined) => {
    if (!p) return;
    await refreshProjects();
    toggleProject(p.path, true);
    useStore.setState({ dialog: "new", newSessionProject: p.path });
  };
  const keepParent = () => localStorage.setItem("tether.projectParent", parent.trim() || DEFAULT_PARENT);
  const run = async (f: () => Promise<ProjectInfo | undefined>) => {
    if (busy) return;
    setBusy(true);
    const p = await f();
    setBusy(false);
    await opened(p);
  };
  const add = () =>
    run(async () => {
      if (missing) return act("addProject", { path, create: true });
      // Typed, not opened with Enter: look first, so a folder that isn't there turns the button into "Create and add".
      const there = path.trim() === cwd ? cwd : await browse(path.trim());
      return there ? act("addProject", { path: there }) : undefined;
    });
  const create = () =>
    name.trim() &&
    run(() => {
      keepParent();
      return act("createProject", {
        name: name.trim(),
        parent: parent.trim() || DEFAULT_PARENT,
        github: account && github ? { owner: owner && owner !== account.login ? owner : undefined, private: isPrivate } : undefined,
      });
    });
  const clone = (r = repo) =>
    r.trim() &&
    run(() => {
      keepParent();
      return act("cloneProject", { repo: r.trim(), parent: parent.trim() || DEFAULT_PARENT });
    });

  const list = repos[listOwner];
  const shown = Array.isArray(list) ? filterRepos(list, filter) : [];
  const ownerPicker = account && account.orgs.length > 0 && (
    <Selector
      label="Owner"
      size="sm"
      value={listOwner}
      options={[account.login, ...account.orgs].map((o) => ({ value: o, label: o }))}
      onChange={(v) => v && setOwner(v)}
    />
  );
  const noGithub =
    account === null &&
    (oldRunner ? (
      <Text type="supporting">For GitHub options, restart the runner: it's older than the web app.</Text>
    ) : (
      <Text type="supporting">For GitHub options, sign in to the GitHub CLI on the runner: gh auth login.</Text>
    ));
  const where = tildify(parent.trim() || DEFAULT_PARENT);
  const action =
    mode === "folder" ? (
      <Button label={missing ? `Create and add ${tildify(path)}` : `Add ${tildify(path)}`} variant="primary" isLoading={busy} onClick={add} />
    ) : mode === "new" ? (
      <Button label={account && github ? "Create project and repo" : "Create project"} variant="primary" isDisabled={!name.trim()} isLoading={busy} onClick={create} />
    ) : (
      <Button label="Clone" variant="primary" isDisabled={!repo.trim()} isLoading={busy} onClick={() => clone()} />
    );

  return (
    <Frame
      title="Add project"
      close={close}
      actions={
        <>
          <Button label="Cancel" onClick={close} />
          {action}
        </>
      }
    >
      <SegmentedControl label="How" value={mode} onChange={(v) => pickMode(v as AddMode)}>
        <SegmentedControlItem value="folder" label={narrow ? "Folder" : "Existing folder"} />
        <SegmentedControlItem value="new" label={narrow ? "New" : "New project"} />
        <SegmentedControlItem value="clone" label={narrow ? "Clone" : "Clone a repo"} />
      </SegmentedControl>
      {mode === "folder" && (
        <VStack gap={2}>
          <TextInput
            label="Folder on the runner"
            value={path}
            onChange={(v) => (setPath(v), setMissing(false))}
            onEnter={() => browse(path)}
            description={missing ? "This folder doesn't exist yet. Add creates it." : "Enter to open it below."}
          />
          <Card variant="muted" padding={0}>
            <VStack isScrollable style={{ maxHeight: "calc(var(--spacing-12) * 5)" }}>
              <List density="compact">
                {dirs.map((d) => (
                  <ListItem
                    key={d}
                    label={d === cwd.replace(/\/[^/]+\/?$/, "") || d.length < cwd.length ? "↑ .." : d.slice(cwd.length).replace(/^\//, "") + "/"}
                    onClick={() => browse(d)}
                  />
                ))}
              </List>
            </VStack>
          </Card>
        </VStack>
      )}
      {mode === "new" && (
        <VStack gap={3}>
          <TextInput label="Name" value={name} onChange={setName} onEnter={() => create()} placeholder="email-reply" hasAutoFocus />
          <TextInput label="Create it in" value={parent} onChange={setParent} description={name.trim() ? `${where}/${name.trim()}, with git init` : undefined} />
          {account ? (
            <VStack gap={2}>
              <Switch label={`Also create a GitHub repo (signed in as ${account.login})`} value={github} onChange={setGithub} />
              {github && (
                <HStack gap={2} wrap="wrap">
                  {ownerPicker}
                  <Group label="Visibility">
                    <SegmentedControl label="Visibility" value={isPrivate ? "private" : "public"} onChange={(v) => setPrivate(v === "private")}>
                      <SegmentedControlItem value="private" label="Private" />
                      <SegmentedControlItem value="public" label="Public" />
                    </SegmentedControl>
                  </Group>
                </HStack>
              )}
            </VStack>
          ) : (
            noGithub
          )}
        </VStack>
      )}
      {mode === "clone" && (
        <VStack gap={2}>
          <TextInput label={`Repo to clone into ${where}`} value={repo} onChange={setRepo} onEnter={() => clone()} placeholder="org/repo or git@github.com:org/repo.git" />
          <TextInput label="Into" value={parent} onChange={setParent} />
          {account ? (
            <VStack gap={1.5}>
              <HStack gap={2} vAlign="end" wrap="wrap">
                {ownerPicker}
                <StackItem size="fill">
                  <TextInput label={ownerPicker ? "Repos" : `Your repos (${account.login})`} size="sm" value={filter} onChange={setFilter} placeholder="Filter…" hasClear />
                </StackItem>
              </HStack>
              <Card variant="muted" padding={0}>
                <VStack isScrollable style={{ maxHeight: "calc(var(--spacing-12) * 5)" }}>
                  {!list || list === "loading" ? (
                    <Spinner size="sm" label="Loading repos…" />
                  ) : list === "failed" || !shown.length ? (
                    <VStack padding={3}>
                      <Text type="supporting">{list === "failed" ? "Couldn't load your repos." : filter.trim() ? "No repos match." : "No repos yet."}</Text>
                    </VStack>
                  ) : (
                    <List density="compact">
                      {shown.map((r) => (
                        <ListItem
                          key={r.nameWithOwner}
                          label={r.nameWithOwner}
                          description={[r.isPrivate ? "Private" : "Public", r.description].filter(Boolean).join(" · ")}
                          isSelected={repo === r.nameWithOwner}
                          onClick={() => setRepo(r.nameWithOwner)}
                        />
                      ))}
                    </List>
                  )}
                </VStack>
              </Card>
            </VStack>
          ) : (
            noGithub
          )}
        </VStack>
      )}
    </Frame>
  );
}

const NARROW = "(max-width: 640px)";
/** Width of a row's control when it sits beside the row's text. */
const CONTROL_WIDTH = "calc(var(--spacing-12) * 4)";

/** A titled, muted card of settings rows separated by hairlines. `scope` notes where it applies, beside the title. */
function SettingsCard({ title, scope, children }: { title: string; scope?: string; children: ReactNode }) {
  const rows = Children.toArray(children);
  return (
    <VStack gap={1.5}>
      <HStack gap={2} hAlign="between" vAlign="center">
        <Text type="supporting" weight="semibold" color="secondary">
          {title}
        </Text>
        {scope && (
          <Text type="supporting" color="placeholder">
            {scope}
          </Text>
        )}
      </HStack>
      <Card padding={0} width="100%" variant="muted">
        <VStack as="ul" role="list" gap={0}>
          {rows.map((row, i) => (
            <VStack key={i} as="li" gap={0}>
              {i > 0 && <Divider variant="subtle" />}
              {row}
            </VStack>
          ))}
        </VStack>
      </Card>
    </VStack>
  );
}

/**
 * One setting: name and a one-line explanation, with its control beside it. On a phone a wide control
 * (a selector) drops below the text; compact ones (switches, buttons) stay beside it. Pass the control `isLabelHidden`.
 */
function SettingsRow({ title, description, control, isControlWide, children }: { title: string; description?: ReactNode; control?: ReactNode; isControlWide?: boolean; children?: ReactNode }) {
  const narrow = useMediaQuery(NARROW) && !!isControlWide;
  return (
    <VStack padding={4} gap={3}>
      <Stack direction={narrow ? "vertical" : "horizontal"} gap={narrow ? 2 : 3} align={narrow ? "stretch" : "center"}>
        <StackItem size="fill">
          <VStack gap={0.5}>
            <Text type="label">{title}</Text>
            {description != null && (
              <Text type="supporting" color="secondary">
                {description}
              </Text>
            )}
          </VStack>
        </StackItem>
        {control != null && <StackItem size="static">{control}</StackItem>}
      </Stack>
      {children}
    </VStack>
  );
}

const NOTIFY_DESCRIPTIONS: Record<NotifyKind, string> = {
  question: "An agent asks you something or needs an approval.",
  finished: "An agent finishes what it was doing.",
  blocked: "An agent is stuck: an action was blocked, every model hit its usage limit, it went quiet, or it failed.",
  memory: "A new memory contradicts an older one. The newest is kept; tap to review it.",
};

/** This device's push notifications from the selected runner. */
function NotificationSettings() {
  const [st, setSt] = useState<{ kinds?: NotifyKind[]; permission: NotificationPermission }>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => {
    if (pushSupported()) pushState().then(setSt).catch((e) => setErr(e.message));
  }, []);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr(undefined);
    try {
      await f();
      setSt(await pushState());
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  const on = st?.kinds;
  const supported = pushSupported();
  const blocked = st?.permission === "denied" && !on;
  const status = !supported
    ? needsHomeScreen()
      ? "On iPhone and iPad, add Tether to the Home Screen (Share → Add to Home Screen) and open it from there first."
      : "This browser can't receive notifications."
    : blocked
      ? "Notifications are blocked for this site. Allow them in your browser's site settings."
      : !st && !err
        ? "Checking…"
        : "Get an alert when an agent needs you, even with Tether closed.";

  return (
    <VStack gap={2}>
      <SettingsCard title="Notifications" scope="This device">
        <SettingsRow
          title="Notify this device"
          description={status}
          control={
            <Switch
              label="Notify this device"
              isLabelHidden
              value={!!on}
              isLoading={busy}
              isDisabled={!supported || !st || blocked || busy}
              onChange={(v) => run(() => (v ? enablePush(NOTIFY_KINDS.map((k) => k.id)) : disablePush()))}
            />
          }
        />
        {on &&
          NOTIFY_KINDS.map((k) => (
            <SettingsRow
              key={k.id}
              title={k.label}
              description={NOTIFY_DESCRIPTIONS[k.id] ?? k.hint}
              control={
                <Switch
                  label={`Notify about ${k.label.toLowerCase()}`}
                  isLabelHidden
                  value={on.includes(k.id)}
                  isDisabled={busy}
                  onChange={(v) => run(() => enablePush(v ? [...on, k.id] : on.filter((x) => x !== k.id)))}
                />
              }
            />
          ))}
        {on && (
          <SettingsRow
            title="Test notification"
            description="Check that notifications reach this device."
            control={<Button label="Send test" size="sm" isDisabled={busy} onClick={() => run(testPush)} />}
          />
        )}
      </SettingsCard>
      {err && <Banner status="error" title={err} collapsible={false} />}
    </VStack>
  );
}

/**
 * The background model ("harness:model") runs Tether's own small jobs: the Auto mode reviewer and
 * memory merges. Same harness + model choice as a session; it draws on that harness's login.
 */
function BackgroundModelPicker({ narrow }: { narrow: boolean }) {
  const runner = useStore((s) => s.runners.find((r) => r.id === s.runnerId));
  const [setting, setSetting] = useState<BackgroundModelSetting>();
  const [harness, setHarness] = useState<HarnessId>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    rpc("getBackgroundModel", {}).then(setSetting).catch(() => {});
  }, []);
  const cur = setting ? parseEntry(setting.model, "claude-code") : undefined;
  const h = harness ?? cur?.harness ?? "claude-code";
  const models = useModels(setting ? [h] : []);
  const usable = (setting?.harnesses ?? []).filter((x) => !runner || runner.harnesses.includes(x));
  const list = models[h] ?? [];
  // The saved model may be an alias ("haiku") the harness doesn't list: keep it pickable.
  const ids = [...(cur && cur.harness === h && !list.some((m) => m.id === cur.model) ? [cur.model] : []), ...list.map((m) => m.id)];
  const pick = async (model: string) => {
    setBusy(true);
    const r = await act("setBackgroundModel", { model: formatEntry({ harness: h, model }) });
    setBusy(false);
    if (r) {
      setSetting(r);
      setHarness(undefined);
    }
  };
  return (
    <Stack direction={narrow ? "vertical" : "horizontal"} gap={2}>
      <Selector
        label="Background model harness"
        isLabelHidden
        size="sm"
        width={narrow ? "100%" : 140}
        isDisabled={!setting || busy}
        value={h}
        options={HARNESSES.filter((x) => setting?.harnesses.includes(x.id)).map((x) => ({
          value: x.id,
          label: usable.includes(x.id) ? x.label : `${x.label} (not installed)`,
          disabled: !usable.includes(x.id),
        }))}
        onChange={(v) => setHarness(v as HarnessId)}
      />
      <StackItem size="fill">
        <Selector
          label="Background model"
          isLabelHidden
          size="sm"
          width="100%"
          presentation="adaptive"
          hasSearch={ids.length > 8}
          searchPlaceholder="Filter models…"
          isLoading={!!setting && !models[h]}
          isDisabled={!setting || busy}
          placeholder={models[h] ? "Pick a model" : "Loading…"}
          value={cur && cur.harness === h ? cur.model : undefined}
          options={ids.map((id) => {
            const d = modelDisplay(id, h);
            return { value: id, label: d.name, description: id === d.name ? undefined : id, icon: modelIcon(d) };
          })}
          onChange={pick}
        />
      </StackItem>
    </Stack>
  );
}

/**
 * The runner's env and secrets (runner/src/secrets.ts): names only come back; a value is typed in
 * to set or replace it.
 */
function SecretsSettings({ narrow }: { narrow: boolean }) {
  const runnerId = useStore((s) => s.runnerId);
  const [secrets, setSecrets] = useState<SecretView[]>();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [replacing, setReplacing] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    rpc("listSecrets", {})
      .then(setSecrets)
      .catch(() => setSecrets([]));
  }, [runnerId]);
  const save = async (n: string, v: string) => {
    setBusy(n);
    setError(undefined);
    try {
      setSecrets(await rpc("setSecret", { name: n, value: v }));
      setName("");
      setValue("");
      setReplacing(undefined);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(undefined);
    }
  };
  const remove = async (n: string) => {
    setBusy(n);
    const next = await act("setSecret", { name: n, remove: true });
    setBusy(undefined);
    if (next) setSecrets(next);
  };
  return (
    <SettingsCard title="Env and secrets">
      <SettingsRow
        title="Environment for agents"
        description={`Every agent gets these as environment variables, and so do the MCP servers Tether starts for it. In an MCP server's env or headers, write \${NAME} to use one. Values stay on this runner.`}
      />
      {(secrets ?? []).map((sec) => (
        <SettingsRow
          key={sec.name}
          title={sec.name}
          description={sec.updatedAt ? `Set ${new Date(sec.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : undefined}
          control={
            <HStack gap={2}>
              <Button label="Replace" size="sm" variant="ghost" isDisabled={!!busy} onClick={() => (setValue(""), setReplacing(replacing === sec.name ? undefined : sec.name))} />
              <Button label="Remove" size="sm" variant="ghost" isLoading={busy === sec.name && replacing !== sec.name} isDisabled={!!busy} onClick={() => remove(sec.name)} />
            </HStack>
          }
        >
          {replacing === sec.name && (
            <HStack gap={2}>
              <StackItem size="fill">
                <TextInput label={`New value for ${sec.name}`} isLabelHidden type="password" autoComplete="off" size="sm" placeholder="New value" value={value} onChange={setValue} />
              </StackItem>
              <Button label="Save" size="sm" variant="primary" isLoading={busy === sec.name} isDisabled={!value} onClick={() => save(sec.name, value)} />
            </HStack>
          )}
        </SettingsRow>
      ))}
      <VStack padding={4} gap={2}>
        <Stack direction={narrow ? "vertical" : "horizontal"} gap={2} align={narrow ? "stretch" : "end"}>
          <StackItem size="fill">
            <TextInput label="Name" size="sm" placeholder="GITHUB_TOKEN" autoComplete="off" value={name} onChange={(v) => (setName(v), setError(undefined))} />
          </StackItem>
          <StackItem size="fill">
            <TextInput label="Value" type="password" autoComplete="off" size="sm" value={replacing ? "" : value} isDisabled={!!replacing} onChange={(v) => (setValue(v), setError(undefined))} />
          </StackItem>
          <StackItem size="static">
            <Button label="Add" size="sm" variant="primary" isLoading={!!busy && busy === name.trim()} isDisabled={!name.trim() || !value || !!replacing} onClick={() => save(name.trim(), value)} />
          </StackItem>
        </Stack>
        {error && (
          <Text type="supporting" style={{ color: "var(--color-text-red)" }}>
            {error}
          </Text>
        )}
      </VStack>
    </SettingsCard>
  );
}

function Settings({ close }: { close: () => void }) {
  const narrow = useMediaQuery(NARROW);
  const runnerId = useStore((s) => s.runnerId);
  const runner = useStore((s) => s.runners.find((r) => r.id === s.runnerId));
  const manyRunners = useStore((s) => s.runners.filter((r) => r.connected).length > 1);
  const ui = useStore((s) => s.ui);
  // undefined until the runner answers, so nothing is saved over profiles not loaded yet
  const [loaded, setProfiles] = useState<ModelProfile[]>();
  const profiles = loaded ?? [];
  const saved = useRef<ModelProfile[]>(undefined);
  const pending = useRef<ModelProfile[]>(undefined);
  const [guard, setGuardInfo] = useState<{ antigravityHook: boolean; judgeModel: string; judgeEnabled: boolean; defaultMode: GuardMode }>();
  useEffect(() => {
    rpc("getProfiles", {})
      .then((p) => {
        saved.current = p;
        setProfiles(p);
      })
      .catch(() => {});
    rpc("guardSetup", {}).then(setGuardInfo).catch(() => {});
  }, []);
  const updateGuard = async (args: { install?: boolean; judgeModel?: string; defaultMode?: GuardMode }) => {
    const r = await act("guardSetup", args);
    if (r) setGuardInfo(r);
  };
  const problems = profileProblems(profiles);
  // Profiles save themselves a moment after the last edit, once every one is valid; closing saves at once.
  const flush = () => {
    const p = pending.current;
    if (!p) return;
    pending.current = undefined;
    saved.current = p;
    act("setProfiles", { profiles: p }).then((r) => {
      if (!r) saved.current = undefined; // retried on the next edit
    });
  };
  useEffect(() => {
    pending.current = profilesToSave(loaded, saved.current);
    if (!pending.current) return;
    const t = setTimeout(flush, 600);
    return () => clearTimeout(t);
  }, [loaded]);
  useEffect(() => flush, []);
  const controlWidth = narrow ? "100%" : CONTROL_WIDTH;
  const setProfile = (i: number, p: Partial<ModelProfile>) => setProfiles(profiles.map((x, j) => (j === i ? { ...x, ...p } : x)));

  return (
    <Frame
      title="Settings"
      subtitle={manyRunners && runnerId ? `For runner ${runnerId}` : undefined}
      close={close}
      actions={<Button label="Done" variant="primary" onClick={close} />}
    >
      <NotificationSettings />
      <SettingsCard title="Sidebar">
        <SettingsRow
          title="Show sessions from the last"
          description="By latest message. Running sessions and ones that need you always show; search finds the rest."
          isControlWide
          control={
            <Selector
              label="Show sessions from the last"
              isLabelHidden
              size="sm"
              width={controlWidth}
              value={String(ui.sidebarDays)}
              options={SIDEBAR_DAYS.map((d) => ({ value: String(d), label: sidebarDaysLabel(d) }))}
              onChange={(v) => v != null && setUiPref({ sidebarDays: Number(v) })}
            />
          }
        />
      </SettingsCard>
      <SettingsCard title="Transcript">
        <SettingsRow
          title="Expand shell commands by default"
          description="Show a command's output without clicking it."
          control={<Switch label="Expand shell commands by default" isLabelHidden value={ui.expandShell} onChange={(v) => setUiPref({ expandShell: v })} />}
        />
      </SettingsCard>
      <SettingsCard title="Leader">
        <SettingsRow
          title="Leader updates"
          description="What your leader hears about by itself. Updates: questions and approvals within a minute, the rest batched every few minutes. Each one is a turn of the leader's model."
          isControlWide
          control={
            <Selector
              label="Leader updates"
              isLabelHidden
              size="sm"
              width={controlWidth}
              value={ui.leaderUpdates}
              options={LEADER_UPDATES.map((u) => ({ value: u.id, label: u.label }))}
              onChange={(v) => v && setUiPref({ leaderUpdates: v as LeaderUpdates })}
            />
          }
        />
      </SettingsCard>
      <SettingsCard title="New sessions">
        <SettingsRow
          title="Default approvals"
          description="How much an agent may do before asking you. You can change it for each session."
          isControlWide
          control={
            <Selector
              label="Default approvals"
              isLabelHidden
              size="sm"
              width={controlWidth}
              isDisabled={!guard}
              value={guard?.defaultMode}
              options={GUARD_MODES.map((g) => ({ value: g.id, label: g.label }))}
              onChange={(g) => updateGuard({ defaultMode: g as GuardMode })}
            />
          }
        />
      </SettingsCard>
      <SecretsSettings narrow={narrow} />
      <Collapsible trigger={<Text type="label">Advanced</Text>}>
        <VStack gap={4} paddingBlockStart={2}>
          <SettingsCard title="Background model and safety">
            <SettingsRow
              title="Background model"
              description="Runs Tether's own small jobs: reviewing actions in Auto mode and merging memories. It uses that harness's login and plan."
            >
              <BackgroundModelPicker narrow={narrow} />
            </SettingsRow>
            <SettingsRow
              title="Auto mode reviewer"
              description={
                guard && !guard.judgeEnabled
                  ? "Off: in Auto mode, actions the built-in safety rules don't cover are blocked."
                  : "In Auto mode, the background model decides on actions the built-in safety rules don't cover."
              }
              control={
                <Switch
                  label="Auto mode reviewer"
                  isLabelHidden
                  isDisabled={!guard}
                  value={!!guard?.judgeEnabled}
                  onChange={async (on) => {
                    // The reviewer always runs on the background model; this only turns it on or off.
                    const r = await act("setJudgeEnabled", { enabled: on });
                    if (r && guard) setGuardInfo({ ...guard, judgeEnabled: r.judge, judgeModel: r.judge ? r.model : "off" });
                  }}
                />
              }
            />
          </SettingsCard>
          <SettingsCard title="Fallback profiles">
            <SettingsRow
              title="Switch models at usage limits"
              description="A profile is a list of models to try in order. When one hits its usage limit, the session moves on to the next. Pick a profile when you start a session."
              control={<Button label="Add profile" size="sm" isDisabled={!loaded} onClick={() => setProfiles([...profiles, { name: "", chain: [] }])} />}
            />
            {profiles.map((p, i) => (
              <VStack key={i} padding={4} gap={2}>
                <HStack gap={2} vAlign="center">
                  <StackItem size="fill">
                    <TextInput label="Profile name" isLabelHidden size="sm" value={p.name} placeholder="Profile name" onChange={(v) => setProfile(i, { name: v })} />
                  </StackItem>
                  <Button label="Remove" size="sm" variant="destructive" onClick={() => setProfiles(profiles.filter((_, j) => j !== i))} />
                </HStack>
                {problems[i] && (
                  <Text type="supporting" style={{ color: "var(--color-text-red)" }}>
                    {problems[i]}. Not saved until fixed.
                  </Text>
                )}
                <ChainEditor chain={p.chain} onChange={(c) => setProfile(i, { chain: c })} />
              </VStack>
            ))}
          </SettingsCard>
        </VStack>
      </Collapsible>
    </Frame>
  );
}
