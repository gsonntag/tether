// "Commands" and "Subagents" on the Memory & Skills page: Tether's libraries of your custom `/`
// commands (runner/src/commands.ts) and subagent definitions (runner/src/subagents.ts). "Find"
// (and Import on the page) reads every harness's own files without changing them; each entry is on
// or off, and a pasted one with the same name replaces it.

import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Switch } from "@astryxdesign/core/Switch";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { TrashIcon } from "@heroicons/react/24/outline";
import type { LibraryCommandView, SubagentView } from "../shared/protocol";
import { act, rpc, useStore } from "../store";
import { harnessLabel } from "../util";
import { HarnessBadge } from "./HarnessBadge";
import { sourceLabel } from "./MemoryConflicts";
import { fromLabel } from "../library";

type Item = { id: string; name: string; enabled: boolean; sources: string[] };

/** The shared list: on/off and delete per entry. */
function LibraryList<T extends Item>({
  items,
  label,
  narrow,
  describe,
  set,
}: {
  items: T[];
  label: (it: T) => string;
  narrow: boolean;
  describe: (it: T) => ReactNode;
  set: (it: T, change: { enabled?: boolean; remove?: boolean }) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string>();
  const run = async (it: T, change: { enabled?: boolean; remove?: boolean }) => {
    setBusy(it.id + Object.keys(change)[0]);
    await set(it, change);
    setBusy(undefined);
  };
  return (
    <List density="compact" hasDividers>
      {items.map((it) => (
        <ListItem
          key={it.id}
          label={label(it)}
          description={describe(it)}
          endContent={
            <HStack gap={narrow ? 2 : 3} vAlign="center">
              <Switch label={`Use ${label(it)}`} isLabelHidden value={it.enabled} isLoading={busy === it.id + "enabled"} isDisabled={!!busy} onChange={(v) => run(it, { enabled: v })} />
              <Button
                label={`Delete ${label(it)}`}
                variant="ghost"
                size="sm"
                icon={<Icon icon={TrashIcon} size="sm" />}
                isIconOnly
                isLoading={busy === it.id + "remove"}
                isDisabled={!!busy}
                onClick={() => run(it, { remove: true })}
              />
            </HStack>
          }
        />
      ))}
    </List>
  );
}

function Sources({ sources }: { sources: string[] }) {
  return (
    <Tooltip content={sources.map((x) => (x === "you" ? "Added by you" : x.slice(x.indexOf(":") + 1))).join("\n")} hasHoverIndication={false}>
      <Text type="supporting" color="secondary">
        {fromLabel(sources, sourceLabel)}
      </Text>
    </Tooltip>
  );
}

function Found({ found, what, onDismiss }: { found: { added: string[]; warnings: string[] }; what: [string, string]; onDismiss: () => void }) {
  const n = found.added.length;
  return (
    <Banner
      status={found.warnings.length ? "warning" : "success"}
      title={n ? `Found ${n === 1 ? `1 new ${what[0]}` : `${n} new ${what[1]}`}` : `No new ${what[1]}`}
      description={found.warnings.join("\n") || undefined}
      collapsible={false}
      isDismissable
      onDismiss={onDismiss}
    />
  );
}

// ---------------- commands ----------------

const COMMAND_EXAMPLE = `---
description: Fix a GitHub issue
argument-hint: [issue-number]
---
Find and fix issue #$ARGUMENTS. Write a test for it.`;

export function CommandsSection({ narrow }: { narrow: boolean }) {
  const runnerId = useStore((s) => s.runnerId);
  const imports = useStore((s) => s.contextLive.filter((a) => a.kind === "import").length);
  const [commands, setCommands] = useState<LibraryCommandView[]>();
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<{ added: string[]; warnings: string[] }>();

  useEffect(() => {
    rpc("listLibraryCommands", {})
      .then(setCommands)
      .catch(() => setCommands([]));
  }, [runnerId, imports]);

  const find = async () => {
    setFinding(true);
    const r = await act("findLibraryCommands", {});
    setFinding(false);
    if (!r) return;
    setCommands(r.commands);
    setFound({ added: r.added, warnings: r.warnings });
  };

  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <HStack gap={2} vAlign="center">
            <Heading level={3}>Commands</Heading>
            {commands && <Badge variant="neutral" label={String(commands.length)} />}
          </HStack>
        </StackItem>
        <Button label="Find commands" size="sm" isLoading={finding} onClick={find} />
      </HStack>
      <Text type="supporting" color="secondary">
        Your custom / commands, in every harness. A harness that has the command itself runs it; for the others Tether fills in the arguments and sends the text.
      </Text>
      {found && <Found found={found} what={["command", "commands"]} onDismiss={() => setFound(undefined)} />}
      {!commands ? (
        <Spinner size="sm" label="Loading commands…" />
      ) : !commands.length ? (
        <EmptyState title="No commands yet" description="Find the ones in Claude Code, Codex, opencode and pi, or add one below." isCompact />
      ) : (
        <LibraryList
          items={commands}
          narrow={narrow}
          label={(c) => `/${c.name}`}
          describe={(c) => (
            <VStack gap={1}>
              {c.description && (
                <Text type="supporting" color="secondary" maxLines={2}>
                  {c.description}
                </Text>
              )}
              <HStack gap={1} vAlign="center" wrap="wrap">
                {c.argumentHint && <Token size="sm" label={c.argumentHint} />}
                <Tooltip content={c.style === "claude" ? "$ARGUMENTS is everything you type; $0 is the first argument" : "$1 is the first argument; $@ is all of them"} hasHoverIndication={false}>
                  <Token size="sm" label={c.style === "claude" ? "Claude Code arguments" : "Shell-style arguments"} />
                </Tooltip>
                <Sources sources={c.sources} />
              </HStack>
            </VStack>
          )}
          set={async (c, change) => {
            const next = await act("setLibraryCommand", { id: c.id, ...change });
            if (next) setCommands(next);
          }}
        />
      )}
      <AddCommand onAdded={setCommands} />
    </VStack>
  );
}

function AddCommand({ onAdded }: { onAdded: (c: LibraryCommandView[]) => void }) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onAdded(await rpc("addLibraryCommand", { name, text }));
      setName("");
      setText("");
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <VStack gap={2} paddingBlockStart={2}>
      <TextInput label="Command name" description="What you type after /. A command with this name is replaced." placeholder="fix-issue" size="sm" value={name} onChange={setName} />
      <TextArea
        label="Text"
        description="The prompt, as in a Claude Code command file. Front matter is optional."
        placeholder={COMMAND_EXAMPLE}
        rows={5}
        value={text}
        onChange={(v) => {
          setText(v);
          setError(undefined);
        }}
        status={error ? { type: "error", message: error } : undefined}
        statusVariant="detached"
      />
      <HStack gap={2}>
        <Button label="Add" variant="primary" size="sm" isLoading={busy} isDisabled={!text.trim() || !name.trim()} onClick={add} />
      </HStack>
    </VStack>
  );
}

// ---------------- subagents ----------------

const AGENT_EXAMPLE = `---
name: reviewer
description: Reviews changes for bugs. Use after making edits.
tools: Read, Grep, Glob
---
You are a careful code reviewer…`;

export function SubagentsSection({ narrow }: { narrow: boolean }) {
  const runnerId = useStore((s) => s.runnerId);
  const imports = useStore((s) => s.contextLive.filter((a) => a.kind === "import").length);
  const [agents, setAgents] = useState<SubagentView[]>();
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<{ added: string[]; warnings: string[] }>();

  useEffect(() => {
    rpc("listSubagents", {})
      .then(setAgents)
      .catch(() => setAgents([]));
  }, [runnerId, imports]);

  const find = async () => {
    setFinding(true);
    const r = await act("findSubagents", {});
    setFinding(false);
    if (!r) return;
    setAgents(r.agents);
    setFound({ added: r.added, warnings: r.warnings });
  };

  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <HStack gap={2} vAlign="center">
            <Heading level={3}>Subagents</Heading>
            {agents && <Badge variant="neutral" label={String(agents.length)} />}
          </HStack>
        </StackItem>
        <Button label="Find subagents" size="sm" isLoading={finding} onClick={find} />
      </HStack>
      <Text type="supporting" color="secondary">
        Your subagent definitions, given to every harness that can run custom subagents, in its own format.
      </Text>
      {found && <Found found={found} what={["subagent", "subagents"]} onDismiss={() => setFound(undefined)} />}
      {!agents ? (
        <Spinner size="sm" label="Loading subagents…" />
      ) : !agents.length ? (
        <EmptyState title="No subagents yet" description="Find the ones in Claude Code, Codex, opencode and pi, or paste one below." isCompact />
      ) : (
        <LibraryList
          items={agents}
          narrow={narrow}
          label={(a) => a.name}
          describe={(a) => {
            const got = a.delivery.filter((d) => d.how !== "none");
            const not = a.delivery.filter((d) => d.how === "none");
            return (
              <VStack gap={1}>
                {a.description && (
                  <Text type="supporting" color="secondary" maxLines={2}>
                    {a.description}
                  </Text>
                )}
                <HStack gap={1} vAlign="center" wrap="wrap">
                  {got.map((d) => (
                    <Tooltip key={d.harness} content={`${harnessLabel(d.harness)}: ${d.note}`} hasHoverIndication={false}>
                      <HarnessBadge harness={d.harness} />
                    </Tooltip>
                  ))}
                  {not.length > 0 && (
                    <Tooltip content={not.map((d) => `${harnessLabel(d.harness)}: ${d.note}`).join("\n")} hasHoverIndication={false}>
                      <Token size="sm" label={`Not in ${not.map((d) => harnessLabel(d.harness)).join(", ")}`} />
                    </Tooltip>
                  )}
                  {a.model && <Token size="sm" label={a.model} />}
                  <Sources sources={a.sources} />
                </HStack>
              </VStack>
            );
          }}
          set={async (a, change) => {
            const next = await act("setSubagent", { id: a.id, ...change });
            if (next) setAgents(next);
          }}
        />
      )}
      <AddSubagent onAdded={setAgents} />
    </VStack>
  );
}

function AddSubagent({ onAdded }: { onAdded: (a: SubagentView[]) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onAdded(await rpc("addSubagent", { text }));
      setText("");
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <VStack gap={2} paddingBlockStart={2}>
      <TextArea
        label="Add a subagent"
        description="Paste a Claude Code agent file: front matter with a name and description, then its instructions. One with the same name is replaced."
        placeholder={AGENT_EXAMPLE}
        rows={5}
        value={text}
        onChange={(v) => {
          setText(v);
          setError(undefined);
        }}
        status={error ? { type: "error", message: error } : undefined}
        statusVariant="detached"
      />
      <HStack gap={2}>
        <Button label="Add" variant="primary" size="sm" isLoading={busy} isDisabled={!text.trim()} onClick={add} />
      </HStack>
    </VStack>
  );
}
