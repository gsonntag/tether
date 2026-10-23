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
import { formatEntry, modelKey, type HarnessId, type LiveState, type ModelRef } from "../shared/protocol";
import { act, learnModels, rpc, useStore } from "../store";
import { modelDisplay, modelLabel, orderLabel } from "../models";
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
  formatValue = format,
}: {
  label: string;
  value: string;
  options: string[];
  onPick: (v: string) => void;
  describe?: Record<string, string>;
  /** display text for a value (options and value stay raw) */
  format?: (v: string) => string;
  /** the trigger's text for the value, when it says more than the options do (default: format) */
  formatValue?: (v: string) => string;
}) {
  const shown = formatValue(value);
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
        .then((r) => {
          learnModels(h, r.models);
          setModels((m) => ({ ...m, [h]: r.models }));
        })
        .catch(() => {});
  }, [harnesses.join(","), sessionId]);
  return models;
}

/**
 * Model picker plus this session's fallback chain: pick one model, use the default order, or edit the
 * order (entries may name another harness; moving to one hands the conversation off).
 */
export function ModelMenu({ sessionId, harness, state }: { sessionId: string; harness: HarnessId; state: LiveState }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const order = useStore((s) => s.defaultOrder);
  useStore((s) => s.aliasVersion); // labels follow what aliases resolve to
  const models = useModels(open ? [harness] : [], sessionId);

  const chain = state.chain ?? [];
  const cur = state.model ?? "default";
  // The model and the credential it runs on ("gpt-6-luna#azure:east"); another credential is another process.
  const curKey = modelKey({ id: cur, credential: state.credential });
  const setChain = (c: string[], preferEarlier = state.preferEarlier) => act("setChain", { sessionId, chain: c, preferEarlier });
  const list = (models[harness] ?? [])
    .map((m) => ({ ...m, key: modelKey(m), d: modelDisplay(m.id, harness), name: modelLabel(m, harness) }))
    .filter((m) => `${m.id} ${m.label ?? ""} ${m.name}`.toLowerCase().includes(filter.toLowerCase()));
  const curD = modelDisplay(cur, harness);
  const label = modelLabel({ id: cur, credential: state.credential }, harness);

  const content = (
    <VStack gap={3}>
      <VStack gap={1.5}>
        <MenuTitle>Fallback order for this session</MenuTitle>
        <ChainEditor chain={chain} onChange={(c) => setChain(c)} sessionId={sessionId} fallback={harness} current={formatEntry({ harness, model: cur, credential: state.credential })} />
        {chain.length > 0 && (
          <CheckboxInput
            size="sm"
            label="Return to earlier entries when their limit resets"
            value={state.preferEarlier !== false}
            onChange={(checked) => setChain(chain, checked)}
          />
        )}
      </VStack>
      {order && JSON.stringify(order) !== JSON.stringify(chain) && (
        <HStack gap={1.5} vAlign="center">
          <Text type="supporting" maxLines={2}>
            Default order: {orderLabel(order)}
          </Text>
          <Button label="Use it" size="sm" onClick={() => act("setModel", { sessionId, defaultOrder: true })} />
        </HStack>
      )}
      <VStack gap={1.5}>
        <MenuTitle>Switch this session's model</MenuTitle>
        <TextInput label="Filter models" isLabelHidden size="sm" placeholder="Filter models…" value={filter} onChange={setFilter} hasClear />
        <VStack style={modelList}>
          {list.slice(0, 200).map((m) => (
            <Item
              key={m.key}
              density="compact"
              startContent={modelIcon(m.d)}
              label={
                <Tooltip content={modelTooltip(m.d)} hasHoverIndication={false}>
                  {m.name}
                </Tooltip>
              }
              description={(m.credential ?? "") !== (state.credential ?? "") ? "Continues in a new session" : m.d.via}
              labelLines={1}
              descriptionLines={1}
              endContent={
                <Button
                  label={m.key === curKey ? "current" : "Use"}
                  size="sm"
                  isDisabled={m.key === curKey}
                  onClick={() => act("setModel", { sessionId, model: m.key })}
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
