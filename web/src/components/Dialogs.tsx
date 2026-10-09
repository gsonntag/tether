import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Code } from "@astryxdesign/core/Code";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Divider } from "@astryxdesign/core/Divider";
import { Field } from "@astryxdesign/core/Field";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector, type SelectorOptionType } from "@astryxdesign/core/Selector";
import { StackItem } from "@astryxdesign/core/Stack";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ToggleButton, ToggleButtonGroup } from "@astryxdesign/core/ToggleButton";
import { VStack } from "@astryxdesign/core/VStack";
import { GUARD_MODES, HARNESSES, NOTIFY_KINDS, type GuardMode, type HarnessId, type ModelProfile, type NotifyKind } from "../shared/protocol";
import { disablePush, enablePush, needsHomeScreen, pushState, pushSupported, testPush } from "../push";

import { act, refreshProjects, rpc, selectSession, toggleProject, useStore } from "../store";
import { tildify } from "../util";
import { ChainEditor } from "./ChainEditor";
import { useModels } from "./ModelMenu";

/** Modal host; the Dialog handles Escape and backdrop clicks. */
export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const close = () => useStore.setState({ dialog: undefined });
  return (
    <Dialog isOpen={!!dialog} onOpenChange={(o) => !o && close()} purpose="info" width={560} maxHeight="90dvh">
      {dialog === "new" && <NewSession close={close} />}
      {dialog === "addProject" && <AddProject close={close} />}
      {dialog === "settings" && <Settings close={close} />}
      {dialog === "notify" && <NotifyPrompt close={close} />}
    </Dialog>
  );
}

/** Header / scrolling body / end-aligned action row, shared by every dialog. */
function Frame({ title, subtitle, close, actions, children }: { title: string; subtitle?: ReactNode; close: () => void; actions: ReactNode; children?: ReactNode }) {
  return (
    <Layout
      height="auto"
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

const choiceLabel = (c: string) => (c.startsWith("profile:") ? c.slice(8) : c || "default");

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
    close();
    toggleProject(project, true);
    selectSession(s.id);
  };

  const projectOptions: SelectorOptionType[] = [
    ...projects.map((p) => ({ value: p.path, label: `${p.name} — ${tildify(p.path)}` })),
    { type: "divider" },
    { value: ADD_PROJECT, label: "Add a project…" },
  ];
  const modelOptions: SelectorOptionType[] = [
    { value: "last", label: `Use last${last ? ` (${choiceLabel(last.choice)}${last.guard ? ` · ${guardLabel(last.guard)}` : ""})` : ""}` },
    { value: DEFAULT_CHOICE, label: "Default" },
    ...(profiles.length > 0
      ? [{ type: "section" as const, title: "Fallback profiles", options: profiles.map((p) => ({ value: `profile:${p.name}`, label: `${p.name}: ${p.chain.join(" → ")}` })) }]
      : []),
    {
      type: "section",
      title: "Models",
      options: (models[harness] ?? []).map((m) => ({ value: m.id, label: m.label && m.label !== m.id ? `${m.id} (${m.label})` : m.id })),
    },
  ];

  return (
    <Frame
      title={fixedProject ? `New session in ${fixedProject.name}` : "New session"}
      close={close}
      actions={
        <>
          <Button label="Cancel" onClick={close} />
          <Button label="Start session" variant="primary" isDisabled={!project} isLoading={busy} onClick={start} />
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
      <VStack onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && start()}>
        <TextArea label="First message" rows={4} value={prompt} onChange={setPrompt} placeholder="What should the agent do?" />
      </VStack>
    </Frame>
  );
}

function AddProject({ close }: { close: () => void }) {
  const [path, setPath] = useState("~");
  const [dirs, setDirs] = useState<string[]>([]);
  const [cwd, setCwd] = useState("");
  const browse = async (p: string) => {
    const r = await act("listDirs", { path: p });
    if (r) {
      setCwd(r.path);
      setPath(r.path);
      setDirs(r.dirs);
    }
  };
  useEffect(() => {
    browse("~");
  }, []);
  const add = async () => {
    const p = await act("addProject", { path });
    if (!p) return;
    await refreshProjects();
    toggleProject(p.path, true);
    useStore.setState({ dialog: "new", newSessionProject: p.path });
  };
  return (
    <Frame
      title="Add project"
      close={close}
      actions={
        <>
          <Button label="Cancel" onClick={close} />
          <Button label={`Add ${tildify(path)}`} variant="primary" clickAction={add} />
        </>
      }
    >
      <VStack gap={2}>
        <TextInput label="Directory on the runner" value={path} onChange={setPath} onEnter={() => browse(path)} />
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
    </Frame>
  );
}

/** Asked once per device, on the first visit. */
function NotifyPrompt({ close }: { close: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const turnOn = async () => {
    setBusy(true);
    try {
      await enablePush(NOTIFY_KINDS.map((k) => k.id));
      close();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      setBusy(false);
    }
  };
  return (
    <Frame
      title="Turn on notifications?"
      subtitle="Get a push when an agent has a question, finishes or gets blocked. You can change this in Settings."
      close={close}
      actions={
        <>
          <Button label="Not now" onClick={close} />
          <Button label="Turn on" variant="primary" isLoading={busy} onClick={turnOn} />
        </>
      }
    >
      {err && <Banner status="error" title={err} collapsible={false} />}
    </Frame>
  );
}

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

  return (
    <VStack gap={3}>
      <Heading level={3}>Notifications</Heading>
      <Text type="supporting">The runner pushes them to this device when an agent has a question, finishes or gets blocked, even with Tether closed.</Text>
      {!pushSupported() ? (
        <Text type="supporting">
          {needsHomeScreen() ? "On iPhone and iPad, add Tether to the Home Screen (Share → Add to Home Screen) and open it from there to get notifications." : "This browser can't receive push notifications."}
        </Text>
      ) : !st ? (
        <Text type="supporting">{err ?? "Checking…"}</Text>
      ) : (
        <>
          {on && (
            <Group label="Notify this device about">
              <ToggleButtonGroup
                label="Notify this device about"
                type="multiple"
                isDisabled={busy}
                value={on}
                onChange={(v) => run(() => enablePush((v as NotifyKind[]) ?? []))}
              >
                {NOTIFY_KINDS.map((k) => (
                  <ToggleButton key={k.id} value={k.id} label={k.label} tooltip={k.hint} />
                ))}
              </ToggleButtonGroup>
            </Group>
          )}
          <HStack gap={2} wrap="wrap">
            {on ? (
              <>
                <Button label="Send a test" isDisabled={busy} onClick={() => run(testPush)} />
                <Button label="Turn off on this device" isDisabled={busy} onClick={() => run(disablePush)} />
              </>
            ) : (
              <Button label="Turn on for this device" variant="primary" isDisabled={busy} onClick={() => run(() => enablePush(NOTIFY_KINDS.map((k) => k.id)))} />
            )}
          </HStack>
          {st.permission === "denied" && <Text type="supporting">Notifications are blocked for this site; allow them in the browser's site settings.</Text>}
          {err && <Banner status="error" title={err} collapsible={false} />}
        </>
      )}
    </VStack>
  );
}

function Settings({ close }: { close: () => void }) {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [guard, setGuardInfo] = useState<{ antigravityHook: boolean; judgeModel: string; defaultMode: GuardMode }>();
  useEffect(() => {
    rpc("getProfiles", {}).then(setProfiles).catch(() => {});
    rpc("guardSetup", {}).then(setGuardInfo).catch(() => {});
  }, []);
  const updateGuard = async (args: { install?: boolean; judgeModel?: string; defaultMode?: GuardMode }) => {
    const r = await act("guardSetup", args);
    if (r) setGuardInfo(r);
  };
  const save = async () => {
    const r = await act("setProfiles", { profiles });
    if (r) {
      setProfiles(r);
      close();
    }
  };
  return (
    <Frame
      title="Settings"
      close={close}
      actions={
        <>
          <Button label="Cancel" onClick={close} />
          <Button label="Save" variant="primary" clickAction={save} />
        </>
      }
    >
      <NotificationSettings />
      <Divider />
      <VStack gap={3}>
        <Heading level={3}>Guard</Heading>
        {guard && (
          <>
            <Group label="Safety judge" description="Decides what the rules don't cover, in Auto.">
              <SegmentedControl label="Safety judge" value={guard.judgeModel} onChange={(m) => updateGuard({ judgeModel: m })}>
                {["haiku", "sonnet", "off"].map((m) => (
                  <SegmentedControlItem key={m} value={m} label={m === "off" ? "Off (deny instead)" : `Claude ${m}`} />
                ))}
              </SegmentedControl>
            </Group>
            <Group label="Default for new sessions">
              <SegmentedControl label="Default for new sessions" value={guard.defaultMode} onChange={(g) => updateGuard({ defaultMode: g as GuardMode })}>
                {GUARD_MODES.map((g) => (
                  <SegmentedControlItem key={g.id} value={g.id} label={g.label} />
                ))}
              </SegmentedControl>
            </Group>
            {guard.antigravityHook ? (
              <Group label="Antigravity hook">
                <Text type="supporting">
                  Installed in <Code>~/.gemini/config/hooks.json</Code>.
                </Text>
              </Group>
            ) : (
              <Group
                label="Antigravity hook"
                description={`Antigravity only lets the guard see its tool calls through a PreToolUse hook. This adds a "tether-guard" entry to ~/.gemini/config/hooks.json; it does nothing for Antigravity runs that Tether didn't start.`}
              >
                <HStack>
                  <Button label="Install hook" clickAction={() => updateGuard({ install: true })} />
                </HStack>
              </Group>
            )}
          </>
        )}
      </VStack>
      <Divider />
      <VStack gap={3}>
        <Heading level={3}>Fallback profiles</Heading>
        <Text type="supporting">
          A profile is an ordered list of <Code>harness:model</Code> entries. When the current entry hits a usage limit the session moves down the list; a
          different harness gets the conversation handed off in the same directory. Rate limits retry on the same entry. Sessions copy the profile and can
          reorder their own copy.
        </Text>
        {profiles.map((p, i) => (
          <Card key={i} padding={3}>
            <VStack gap={2}>
              <HStack gap={2} vAlign="center">
                <StackItem size="fill">
                  <TextInput
                    label="Profile name"
                    isLabelHidden
                    value={p.name}
                    placeholder="name"
                    onChange={(v) => setProfiles(profiles.map((x, j) => (j === i ? { ...x, name: v } : x)))}
                  />
                </StackItem>
                <Button label="Remove" variant="destructive" onClick={() => setProfiles(profiles.filter((_, j) => j !== i))} />
              </HStack>
              <ChainEditor chain={p.chain} onChange={(c) => setProfiles(profiles.map((x, j) => (j === i ? { ...x, chain: c } : x)))} />
            </VStack>
          </Card>
        ))}
        <HStack>
          <Button label="Add profile" onClick={() => setProfiles([...profiles, { name: "", chain: [] }])} />
        </HStack>
      </VStack>
    </Frame>
  );
}
