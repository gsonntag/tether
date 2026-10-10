import { useMemo, useState, type CSSProperties } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Item } from "@astryxdesign/core/Item";
import { Selector } from "@astryxdesign/core/Selector";
import type { SelectorOptionType } from "@astryxdesign/core/Selector";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Stack, StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { formatEntry, HARNESSES, parseEntry, usageProvider, type HarnessId, type ModelRef } from "../shared/protocol";
import { useStore } from "../store";
import { modelDisplay } from "../models";
import { HarnessBadge } from "./HarnessBadge";
import { modelIcon, ModelName } from "./ModelName";
import { useModels } from "./ModelMenu";

/** Groups a harness's models by provider prefix ("openai-codex/gpt-6-luna" → "openai-codex"). */
function groups(models: ModelRef[]): [string, ModelRef[]][] {
  const g = new Map<string, ModelRef[]>();
  for (const m of models) {
    const k = m.id.includes("/") ? m.id.slice(0, m.id.indexOf("/")) : "";
    g.set(k, [...(g.get(k) ?? []), m]);
  }
  return [...g.entries()];
}

function useAvailable(): HarnessId[] {
  const runner = useStore((s) => s.runners.find((r) => r.id === s.runnerId));
  return runner?.harnesses ?? [];
}

const plainList: CSSProperties = { listStyle: "none", margin: 0 };
const row = (tone: "bad" | "warn" | "ok"): CSSProperties => ({
  border: "var(--border-width) solid",
  borderColor: tone === "bad" ? "var(--color-border-red)" : tone === "warn" ? "var(--color-border-yellow)" : "var(--color-border)",
  borderRadius: "var(--radius-element)",
});
const allBox: CSSProperties = {
  maxHeight: "40vh",
  overflowY: "auto",
  border: "var(--border-width) solid var(--color-border)",
  borderRadius: "var(--radius-element)",
};

/**
 * Edits a fallback chain: ordered harness:model entries with dropdowns for adding, a check on each
 * entry (harness installed, model known, current plan usage) and the full list of valid entries.
 */
export function ChainEditor({
  chain,
  onChange,
  sessionId,
  fallback,
  current,
}: {
  chain: string[];
  onChange: (c: string[]) => void;
  sessionId?: string;
  /** harness of entries written without a "harness:" prefix (the session's own) */
  fallback?: HarnessId;
  /** the entry the session runs on now */
  current?: string;
}) {
  const available = useAvailable();
  const narrow = useMediaQuery("(max-width: 640px)");
  const models = useModels(available, sessionId);
  const usage = useStore((s) => s.usage);
  const [h, setH] = useState<HarnessId | "">("");
  const [m, setM] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState("");

  const harness = (h || available[0] || "claude-code") as HarnessId;
  const list = models[harness] ?? [];
  const model = m && list.some((x) => x.id === m) ? m : (list[0]?.id ?? "");

  const move = (i: number, d: number) => {
    const c = [...chain];
    const [x] = c.splice(i, 1);
    c.splice(i + d, 0, x!);
    onChange(c);
  };
  const add = (entry: string) => !chain.includes(entry) && onChange([...chain, entry]);

  const check = (raw: string) => {
    const { harness: eh, model: em } = parseEntry(raw, fallback ?? "claude-code");
    const known = !!fallback || HARNESSES.some((x) => raw.startsWith(x.id + ":"));
    if (!known) return { bad: `Unknown harness. Use one of: ${HARNESSES.map((x) => x.id).join(", ")}` };
    if (!available.includes(eh)) return { bad: `${HARNESSES.find((x) => x.id === eh)?.label} is not installed on this runner` };
    const ms = models[eh];
    if (ms && em && em !== "default" && !ms.some((x) => x.id === em || x.label === em))
      return { warn: `Not in ${HARNESSES.find((x) => x.id === eh)?.label}'s model list (an alias may still work)` };
    const prov = usageProvider(eh, em);
    const u = prov && usage?.providers.find((p) => p.provider === prov);
    const w5 = u?.windows.find((w) => w.label === "5h");
    const wk = u?.windows.find((w) => w.label === "Weekly");
    return { usage: u && !u.error ? `${u.label}: 5h ${w5?.percent ?? "–"}% · wk ${wk?.percent ?? "–"}%` : undefined };
  };

  const all = useMemo(() => {
    const f = filter.toLowerCase();
    return available.map((hid) => ({
      harness: hid,
      models: (models[hid] ?? []).filter((x) => !f || `${hid}:${x.id} ${x.label ?? ""} ${modelDisplay(x.id, hid).name}`.toLowerCase().includes(f)),
    }));
  }, [available, models, filter]);

  const harnessOptions: SelectorOptionType[] = HARNESSES.map((x) => ({
    value: x.id,
    label: available.includes(x.id) ? x.label : `${x.label} (not installed)`,
    disabled: !available.includes(x.id),
  }));
  const option = (x: ModelRef) => {
    const d = modelDisplay(x.id, harness);
    return { value: x.id, label: d.name, description: x.id, icon: modelIcon(d) };
  };
  const modelOptions: SelectorOptionType[] = groups(list).flatMap(([g, ms]): SelectorOptionType[] =>
    g ? [{ type: "section", title: g, options: ms.map(option) }] : ms.map(option),
  );
  const notInstalled = HARNESSES.filter((x) => !available.includes(x.id));

  return (
    <VStack gap={1.5}>
      {chain.length === 0 && <Text type="supporting">Empty: a usage limit just stops the session.</Text>}
      {chain.length > 0 && (
        <VStack as="ol" gap={0.5} padding={0} style={plainList}>
          {chain.map((raw, i) => {
            const { harness: eh, model: em } = parseEntry(raw, fallback ?? "claude-code");
            const c = check(raw);
            const isCur = current !== undefined && formatEntry({ harness: eh, model: em }) === current;
            const subs = [c.usage].filter(Boolean) as string[];
            return (
              <Item
                key={raw + i}
                as="li"
                density="compact"
                style={row(c.bad ? "bad" : c.warn ? "warn" : "ok")}
                marker={
                  <Text type="supporting" hasTabularNumbers>
                    {i + 1}
                  </Text>
                }
                startContent={<HarnessBadge harness={eh} />}
                label={
                  <HStack gap={1.5} vAlign="center">
                    <ModelName id={em || undefined} harness={eh} />
                    {isCur && <Token size="sm" color="blue" label="current" />}
                  </HStack>
                }
                description={
                  subs.length || c.bad || c.warn ? (
                    <VStack>
                      {(c.bad || c.warn) && (
                        <Text type="supporting" style={{ color: c.bad ? "var(--color-text-red)" : "var(--color-text-yellow)" }}>
                          {c.bad ?? c.warn}
                        </Text>
                      )}
                      {subs.map((s) => (
                        <Text key={s} type="supporting">
                          {s}
                        </Text>
                      ))}
                    </VStack>
                  ) : undefined
                }
                endContent={
                  <HStack gap={0.5}>
                    <IconButton label="Up" tooltip="Up" variant="ghost" size="sm" icon={<Icon icon="arrowUp" />} isDisabled={i === 0} onClick={() => move(i, -1)} />
                    <IconButton
                      label="Down"
                      tooltip="Down"
                      variant="ghost"
                      size="sm"
                      icon={<Icon icon="arrowDown" />}
                      isDisabled={i === chain.length - 1}
                      onClick={() => move(i, 1)}
                    />
                    <IconButton
                      label="Remove"
                      tooltip="Remove"
                      variant="ghost"
                      size="sm"
                      icon={<Icon icon="close" />}
                      onClick={() => onChange(chain.filter((_, j) => j !== i))}
                    />
                  </HStack>
                }
              />
            );
          })}
        </VStack>
      )}

      {/* Phones: the harness gets its own row, so the model name and Add aren't squeezed to "…". */}
      <Stack direction={narrow ? "vertical" : "horizontal"} gap={1.5} vAlign={narrow ? undefined : "center"}>
        <Selector
          label="Harness"
          isLabelHidden
          size="sm"
          width={narrow ? "100%" : 140}
          presentation="adaptive"
          options={harnessOptions}
          value={harness}
          onChange={(v) => (setH(v as HarnessId), setM(""))}
        />
        <StackItem size="fill">
          <HStack gap={1.5} vAlign="center">
            <StackItem size="fill">
              <Selector
                label="Model"
                isLabelHidden
                size="sm"
                width="100%"
                presentation="adaptive"
                hasSearch={list.length > 8}
                searchPlaceholder="Filter models…"
                options={modelOptions}
                value={model || undefined}
                placeholder={models[harness] ? "No models" : "Loading…"}
                isLoading={!models[harness]}
                isDisabled={!list.length}
                onChange={setM}
              />
            </StackItem>
            <Button
              label="Add"
              size="sm"
              isDisabled={!model || chain.includes(formatEntry({ harness, model }))}
              onClick={() => add(formatEntry({ harness, model }))}
            />
          </HStack>
        </StackItem>
      </Stack>

      <HStack>
        <Button
          variant="ghost"
          size="sm"
          label={showAll ? "Hide the list of valid entries" : `Show every valid entry (${all.reduce((n, g) => n + (models[g.harness]?.length ?? 0), 0)})`}
          onClick={() => setShowAll(!showAll)}
        />
      </HStack>
      {showAll && (
        <VStack gap={1.5} padding={2} style={allBox}>
          <TextInput label="Filter entries" isLabelHidden size="sm" placeholder="Filter, e.g. codex, opus, azure…" value={filter} onChange={setFilter} hasClear />
          {all.map((g) => (
            <VStack key={g.harness} gap={0.5}>
              <HStack gap={1.5} vAlign="center">
                <HarnessBadge harness={g.harness} />
                <Text type="label" color="secondary">
                  {HARNESSES.find((x) => x.id === g.harness)?.label}
                </Text>
                {!models[g.harness] && <Text type="supporting">loading…</Text>}
              </HStack>
              {g.models.map((x) => {
                const entry = formatEntry({ harness: g.harness, model: x.id });
                return (
                  <HStack key={x.id} gap={1.5} vAlign="center">
                    <StackItem size="fill">
                      <ModelName id={x.id} harness={g.harness} />
                    </StackItem>
                    <Button label={chain.includes(entry) ? "added" : "+ add"} size="sm" variant="ghost" isDisabled={chain.includes(entry)} onClick={() => add(entry)} />
                  </HStack>
                );
              })}
            </VStack>
          ))}
          {notInstalled.length > 0 && <Text type="supporting">Not installed on this runner: {notInstalled.map((x) => x.label).join(", ")}.</Text>}
        </VStack>
      )}
    </VStack>
  );
}
