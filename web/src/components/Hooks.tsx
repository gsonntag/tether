// "Hooks" on the Memory & Skills page: your Claude Code-style command hooks (runner/src/hooks.ts),
// run once by Tether for every harness. Each one is on or off and edited as JSON in Claude Code's
// shape; "Find hooks" (and Import on the page) reads ~/.claude/settings.json without changing it.

import { useEffect, useState } from "react";
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
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { PencilIcon, TrashIcon } from "@heroicons/react/24/outline";
import type { HookView } from "../shared/protocol";
import { act, rpc, useStore } from "../store";
import { hookJson, hookLabel } from "../hooks";

const EXAMPLE = `{
  "event": "PreToolUse",
  "matcher": "Bash",
  "hooks": [{ "type": "command", "command": "~/bin/check-command.sh" }]
}`;

export function HooksSection({ narrow }: { narrow: boolean }) {
  const runnerId = useStore((s) => s.runnerId);
  // A finished import (the page's Turn on) may have brought hooks in.
  const imports = useStore((s) => s.contextLive.filter((a) => a.kind === "import").length);
  const [hooks, setHooks] = useState<HookView[]>();
  const [busy, setBusy] = useState<string>();
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<{ added: number; warnings: string[] }>();
  const [editing, setEditing] = useState<string>();

  useEffect(() => {
    rpc("listHooks", {})
      .then(setHooks)
      .catch(() => setHooks([]));
  }, [runnerId, imports]);

  const set = async (h: HookView, change: { enabled?: boolean; remove?: boolean }) => {
    setBusy(h.id + Object.keys(change)[0]);
    const next = await act("setHook", { id: h.id, ...change });
    setBusy(undefined);
    if (next) setHooks(next);
  };

  const find = async () => {
    setFinding(true);
    const r = await act("findHooks", {});
    setFinding(false);
    if (!r) return;
    setHooks(r.hooks);
    setFound({ added: r.added, warnings: r.warnings });
  };

  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <HStack gap={2} vAlign="center">
            <Heading level={3}>Hooks</Heading>
            {hooks && <Badge variant="neutral" label={String(hooks.length)} />}
          </HStack>
        </StackItem>
        <Button label="Find hooks" size="sm" isLoading={finding} onClick={find} />
      </HStack>
      <Text type="supporting" color="secondary">
        Commands that run before and after tool calls, when a turn ends, and before your messages go out, in every harness. Same format as Claude Code's hooks;
        tool names match Claude Code's (Bash, Edit, Write, Read, mcp__server__tool) everywhere.
      </Text>
      {found && (
        <Banner
          status={found.warnings.length ? "warning" : "success"}
          title={found.added ? `Found ${found.added === 1 ? "1 new hook" : `${found.added} new hooks`} in Claude Code's settings` : "No new hooks"}
          description={found.warnings.join("\n") || undefined}
          collapsible={false}
          isDismissable
          onDismiss={() => setFound(undefined)}
        />
      )}
      {!hooks ? (
        <Spinner size="sm" label="Loading hooks…" />
      ) : !hooks.length ? (
        <EmptyState title="No hooks yet" description="Find the ones in Claude Code's settings, or paste one below." isCompact />
      ) : (
        <List density="compact" hasDividers>
          {hooks.map((h) => (
            <ListItem
              key={h.id}
              label={hookLabel(h)}
              description={
                <VStack gap={1}>
                  {editing === h.id ? (
                    <EditHook
                      hook={h}
                      onDone={(next) => {
                        if (next) setHooks(next);
                        setEditing(undefined);
                      }}
                    />
                  ) : (
                    h.hooks.map((c, i) => (
                      <Text key={i} type="supporting" color="secondary" maxLines={2} style={{ wordBreak: "break-all", fontFamily: "var(--font-mono, monospace)" }}>
                        {c.command}
                      </Text>
                    ))
                  )}
                  <HStack gap={1} vAlign="center" wrap="wrap">
                    <Token size="sm" label={h.event} />
                    {(h.event === "PreToolUse" || h.event === "PostToolUse") && <Token size="sm" label={h.matcher || "Every tool"} />}
                    {h.claudeNative && (
                      <Tooltip content="It's in Claude Code's own settings, so Claude Code runs it there and Tether doesn't run it again" hasHoverIndication={false}>
                        <Token size="sm" label="Claude Code runs it itself" />
                      </Tooltip>
                    )}
                    <Text type="supporting" color="secondary">
                      {h.sources.includes("you") ? "Added by you" : "From Claude Code's settings"}
                    </Text>
                  </HStack>
                </VStack>
              }
              endContent={
                <HStack gap={narrow ? 2 : 3} vAlign="center">
                  <Button
                    label={`Edit ${hookLabel(h)}`}
                    variant="ghost"
                    size="sm"
                    icon={<Icon icon={PencilIcon} size="sm" />}
                    isIconOnly
                    isDisabled={!!busy || editing === h.id}
                    onClick={() => setEditing(h.id)}
                  />
                  <Switch label={`Use ${hookLabel(h)}`} isLabelHidden value={h.enabled} isLoading={busy === h.id + "enabled"} isDisabled={!!busy} onChange={(v) => set(h, { enabled: v })} />
                  <Button
                    label={`Delete ${hookLabel(h)}`}
                    variant="ghost"
                    size="sm"
                    icon={<Icon icon={TrashIcon} size="sm" />}
                    isIconOnly
                    isLoading={busy === h.id + "remove"}
                    isDisabled={!!busy}
                    onClick={() => set(h, { remove: true })}
                  />
                </HStack>
              }
            />
          ))}
        </List>
      )}
      <AddHook onAdded={setHooks} />
    </VStack>
  );
}

function EditHook({ hook, onDone }: { hook: HookView; onDone: (next?: HookView[]) => void }) {
  const [text, setText] = useState(() => hookJson(hook));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onDone(await rpc("setHook", { id: hook.id, json: text }));
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <VStack gap={2}>
      <TextArea
        label="Hook"
        isLabelHidden
        rows={6}
        value={text}
        onChange={(v) => {
          setText(v);
          setError(undefined);
        }}
        status={error ? { type: "error", message: error } : undefined}
        statusVariant="detached"
      />
      <HStack gap={2}>
        <Button label="Save" variant="primary" size="sm" isLoading={busy} isDisabled={!text.trim()} onClick={save} />
        <Button label="Cancel" size="sm" isDisabled={busy} onClick={() => onDone()} />
      </HStack>
    </VStack>
  );
}

function AddHook({ onAdded }: { onAdded: (h: HookView[]) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onAdded(await rpc("addHooks", { text }));
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
        label="Add a hook"
        description="Paste JSON: one hook like the example, or the hooks block from a Claude Code settings file"
        placeholder={EXAMPLE}
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
