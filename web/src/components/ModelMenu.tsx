import { useEffect, useState, type CSSProperties } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Item } from "@astryxdesign/core/Item";
import { Popover } from "@astryxdesign/core/Popover";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { VStack } from "@astryxdesign/core/VStack";
import { ArrowsRightLeftIcon } from "@heroicons/react/24/outline";
import { formatEntry, type HarnessId, type LiveState, type ModelProfile, type ModelRef } from "../shared/protocol";
import { act, rpc } from "../store";
import { chainLabel, modelDisplay } from "../models";
import { ChainEditor } from "./ChainEditor";
import { modelIcon, modelTooltip } from "./ModelName";

const modelList: CSSProperties = { maxHeight: "30vh", overflowY: "auto" };

/** A section title inside a menu surface. */
export function MenuTitle({ children }: { children: string }) {
  return (
    <Text type="supporting" weight="semibold">
      {children}
    </Text>
  );
}

/** A ghost trigger showing "label value"; picking an option calls onPick. Closes on pick, Escape or click-away. */
export function PickMenu({
  label,
  value,
  options,
  onPick,
  describe,
  format = (v) => v,
}: {
  label: string;
  value: string;
  options: string[];
  onPick: (v: string) => void;
  describe?: Record<string, string>;
  /** display text for a value (options and value stay raw) */
  format?: (v: string) => string;
}) {
  const shown = format(value);
  return (
    <DropdownMenu
      button={{
        label: label ? `${label}: ${shown}` : shown,
        variant: "ghost",
        size: "sm",
        children: label ? (
          <>
            <Text color="secondary" type="inherit">
              {label}
            </Text>{" "}
            {shown}
          </>
        ) : undefined,
      }}
      placement="above"
      presentation="adaptive"
      menuWidth={describe ? 300 : 220}
      items={options.map((o) => ({
        id: o,
        label: format(o),
        description: describe?.[o],
        endContent: o === value ? <Icon icon="check" size="sm" color="accent" /> : undefined,
        onClick: () => onPick(o),
      }))}
    />
  );
}

/** Loads the model lists of every harness (for building cross-harness chains). */
export function useModels(harnesses: HarnessId[], sessionId?: string) {
  const [models, setModels] = useState<Record<string, ModelRef[]>>({});
  useEffect(() => {
    for (const h of harnesses)
      rpc("listModels", { harness: h, sessionId })
        .then((r) => setModels((m) => ({ ...m, [h]: r.models })))
        .catch(() => {});
  }, [harnesses.join(","), sessionId]);
  return models;
}

/**
 * Model picker plus this session's fallback chain: pick one model, apply a profile, or edit the
 * order (entries may name another harness; moving to one hands the conversation off).
 */
export function ModelMenu({ sessionId, harness, state }: { sessionId: string; harness: HarnessId; state: LiveState }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const models = useModels(open ? [harness] : [], sessionId);
  useEffect(() => {
    if (open) rpc("getProfiles", {}).then(setProfiles).catch(() => {});
  }, [open]);

  const chain = state.chain ?? [];
  const cur = state.model ?? "default";
  const setChain = (c: string[], preferEarlier = state.preferEarlier) => act("setChain", { sessionId, chain: c, preferEarlier });
  const list = (models[harness] ?? [])
    .map((m) => ({ ...m, d: modelDisplay(m.id, harness) }))
    .filter((m) => `${m.id} ${m.label ?? ""} ${m.d.name}`.toLowerCase().includes(filter.toLowerCase()));
  const curD = modelDisplay(cur, harness);
  const label = state.profile ? `${state.profile} · ${curD.name}` : curD.name;

  const content = (
    <VStack gap={3}>
      <VStack gap={1.5}>
        <MenuTitle>Fallback order for this session</MenuTitle>
        <ChainEditor chain={chain} onChange={(c) => setChain(c)} sessionId={sessionId} fallback={harness} current={formatEntry({ harness, model: cur })} />
        {chain.length > 0 && (
          <CheckboxInput
            size="sm"
            label="Return to earlier entries when their limit resets"
            value={state.preferEarlier !== false}
            onChange={(checked) => setChain(chain, checked)}
          />
        )}
      </VStack>
      {profiles.length > 0 && (
        <VStack gap={1.5}>
          <MenuTitle>Apply a profile</MenuTitle>
          <HStack gap={1.5} wrap="wrap">
            {profiles.map((p) => (
              <Button
                key={p.name}
                label={p.name}
                size="sm"
                variant={state.profile === p.name ? "primary" : "secondary"}
                tooltip={chainLabel(p.chain, harness)}
                onClick={() => act("setModel", { sessionId, profile: p.name })}
              />
            ))}
          </HStack>
        </VStack>
      )}
      <VStack gap={1.5}>
        <MenuTitle>Switch this session's model</MenuTitle>
        <TextInput label="Filter models" isLabelHidden size="sm" placeholder="Filter models…" value={filter} onChange={setFilter} hasClear />
        <VStack style={modelList}>
          {list.slice(0, 200).map((m) => (
            <Item
              key={m.id}
              density="compact"
              startContent={modelIcon(m.d)}
              label={
                <Tooltip content={modelTooltip(m.d)} hasHoverIndication={false}>
                  {m.d.name}
                </Tooltip>
              }
              description={m.d.via}
              labelLines={1}
              descriptionLines={1}
              endContent={
                <Button
                  label={m.id === cur ? "current" : "Use"}
                  size="sm"
                  isDisabled={m.id === cur}
                  onClick={() => act("setModel", { sessionId, model: m.id })}
                />
              }
            />
          ))}
          {!models[harness] && <Spinner size="sm" label="Loading…" />}
        </VStack>
      </VStack>
    </VStack>
  );

  return (
    <Popover label="Model and fallback order" content={content} isOpen={open} onOpenChange={setOpen} placement="above" width={480}>
      <Button
        label={`Model: ${label}`}
        variant="ghost"
        size="sm"
        tooltip={modelTooltip(curD)}
        icon={chain.length ? <Icon icon={ArrowsRightLeftIcon} /> : modelIcon(curD)}
        endContent={<Icon icon="chevronDown" />}
      >
        {label}
      </Button>
    </Popover>
  );
}
