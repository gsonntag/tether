import { Children, useEffect, useId, useMemo, useState, type ReactNode } from "react";
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
  NOTIFY_KINDS,
  parseEntry,
  type BackgroundModelSetting,
  type GuardMode,
  type HarnessId,
  type ModelProfile,
  type NotifyKind,
} from "../shared/protocol";
import { profileProblems } from "../shared/profiles";
import { disablePush, enablePush, needsHomeScreen, pushState, pushSupported, testPush } from "../push";

import { act, refreshProjects, rpc, selectSession, toggleProject, useStore } from "../store";
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
      {dialog === "notify" && <NotifyPrompt close={close} />}
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

const NARROW = "(max-width: 640px)";
/** Width of a row's control when it sits beside the row's text. */
const CONTROL_WIDTH = "calc(var(--spacing-12) * 4)";

/** A titled, muted card of settings rows separated by hairlines. */
function SettingsCard({ title, children }: { title: string; children: ReactNode }) {
  const rows = Children.toArray(children);
  return (
    <VStack gap={1.5}>
      <Text type="supporting" weight="semibold" color="secondary">
        {title}
      </Text>
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
      <SettingsCard title="Notifications">
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

function Settings({ close }: { close: () => void }) {
  const narrow = useMediaQuery(NARROW);
  const runnerId = useStore((s) => s.runnerId);
  const runner = useStore((s) => s.runners.find((r) => r.id === s.runnerId));
  const manyRunners = useStore((s) => s.runners.filter((r) => r.connected).length > 1);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [saved, setSaved] = useState<ModelProfile[]>([]);
  const [guard, setGuardInfo] = useState<{ antigravityHook: boolean; judgeModel: string; judgeEnabled: boolean; defaultMode: GuardMode }>();
  useEffect(() => {
    rpc("getProfiles", {})
      .then((p) => {
        setProfiles(p);
        setSaved(p);
      })
      .catch(() => {});
    rpc("guardSetup", {}).then(setGuardInfo).catch(() => {});
  }, []);
  const updateGuard = async (args: { install?: boolean; judgeModel?: string; defaultMode?: GuardMode }) => {
    const r = await act("guardSetup", args);
    if (r) setGuardInfo(r);
  };
  const dirty = JSON.stringify(profiles) !== JSON.stringify(saved);
  const problems = profileProblems(profiles);
  const invalid = dirty && problems.some(Boolean);
  // Everything else applies as you change it; profile edits are saved here.
  const done = async () => {
    if (invalid) return;
    if (dirty && !(await act("setProfiles", { profiles }))) return;
    close();
  };
  const controlWidth = narrow ? "100%" : CONTROL_WIDTH;
  const setProfile = (i: number, p: Partial<ModelProfile>) => setProfiles(profiles.map((x, j) => (j === i ? { ...x, ...p } : x)));

  return (
    <Frame
      title="Settings"
      subtitle={manyRunners && runnerId ? `For runner ${runnerId}` : undefined}
      close={close}
      actions={<Button label={dirty ? "Save and close" : "Done"} variant="primary" isDisabled={invalid} clickAction={done} />}
    >
      <NotificationSettings />
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
      <Collapsible trigger={<Text type="label">Advanced</Text>} defaultIsOpen={dirty}>
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
          <VStack gap={1.5}>
            <SettingsCard title="Fallback profiles">
              <SettingsRow
                title="Switch models at usage limits"
                description="A profile is a list of models to try in order. When one hits its usage limit, the session moves on to the next. Pick a profile when you start a session."
                control={<Button label="Add profile" size="sm" onClick={() => setProfiles([...profiles, { name: "", chain: [] }])} />}
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
                      {problems[i]}
                    </Text>
                  )}
                  <ChainEditor chain={p.chain} onChange={(c) => setProfile(i, { chain: c })} />
                </VStack>
              ))}
            </SettingsCard>
            {dirty && (
              <Text type="supporting">
                {invalid ? "Fix the profiles marked in red to save, or close to discard the changes." : "Profile changes are saved when you press Save and close."}
              </Text>
            )}
          </VStack>
        </VStack>
      </Collapsible>
    </Frame>
  );
}
