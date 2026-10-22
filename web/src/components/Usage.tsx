import { useState, type CSSProperties } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Popover } from "@astryxdesign/core/Popover";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { StackItem } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { usageProvider, type ProviderUsage, type UsageWindow } from "../shared/protocol";
import { refreshUsage, useStore } from "../store";
import { fmtClock } from "../util";

type Level = "ok" | "warn" | "crit";
const level = (p?: number): Level => (p === undefined ? "ok" : p >= 90 ? "crit" : p >= 70 ? "warn" : "ok");
const barVariant = { ok: "accent", warn: "warning", crit: "error" } as const;
const short = (l: string) => (l === "Weekly" ? "wk" : l);
/** A credit amount, trimmed: 106.36 → "106.36", 1000 → "1,000". */
const fmtNum = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 }));
/** A window carrying raw amounts (Kiro's credit pool) shows "used / limit"; others show a percent. */
const hasAmounts = (w: UsageWindow): w is UsageWindow & { used: number; limit: number } => w.used != null && w.limit != null;

function Bar({ w }: { w: UsageWindow }) {
  return (
    <VStack gap={0.5}>
      <ProgressBar
        label={w.label}
        value={w.percent ?? 0}
        hasValueLabel
        formatValueLabel={(v) => (hasAmounts(w) ? `${fmtNum(w.used)} / ${fmtNum(w.limit)}` : w.percent === undefined ? "–" : `${Math.round(v)}%`)}
        variant={barVariant[level(w.percent)]}
      />
      {w.resetsAt && <Text type="supporting">resets {fmtClock(w.resetsAt)}</Text>}
    </VStack>
  );
}

export function ProviderBlock({ p }: { p: ProviderUsage }) {
  return (
    <VStack gap={1.5}>
      <HStack gap={1.5} vAlign="center" wrap="wrap">
        <Text weight="semibold">{p.label}</Text>
        {p.plan && <Token size="sm" label={p.plan} />}
        {p.limited && <Token size="sm" color="red" label="limit reached" />}
      </HStack>
      {p.error ? <Text type="supporting">{p.error}</Text> : p.windows.map((w) => <Bar key={w.label} w={w} />)}
    </VStack>
  );
}

function AllUsage() {
  const usage = useStore((s) => s.usage);
  return (
    <VStack gap={3}>
      {!usage ? (
        <Text type="supporting">Loading usage…</Text>
      ) : usage.providers.length === 0 ? (
        <Text type="supporting">No subscription logins found (Claude, Codex via pi, or Kiro).</Text>
      ) : (
        usage.providers.map((p) => <ProviderBlock key={p.provider} p={p} />)
      )}
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">{usage && <Text type="supporting">Updated {fmtClock(usage.fetchedAt)}</Text>}</StackItem>
        <Button label="Refresh" variant="ghost" size="sm" onClick={() => refreshUsage(true)} />
      </HStack>
    </VStack>
  );
}

/** What the session itself reports: its cost so far and its extensions' status lines (pi's usage lines). */
function SessionDetails({ statuses, spent }: { statuses: [string, string][]; spent?: string }) {
  return (
    <VStack gap={1.5}>
      <Text weight="semibold">This session</Text>
      {spent && (
        <HStack gap={2} vAlign="center">
          <StackItem size="fill">
            <Text type="supporting">Cost so far</Text>
          </StackItem>
          <Text hasTabularNumbers>{spent}</Text>
        </HStack>
      )}
      {statuses.map(([k, v]) => (
        <VStack key={k} gap={0.5}>
          <Text type="supporting">{k}</Text>
          <Text type="code" style={wrapCode}>
            {v}
          </Text>
        </VStack>
      ))}
    </VStack>
  );
}
const wrapCode: CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word" };

/**
 * Settings-bar pill: the 5h / weekly usage of the subscription this session runs on. Its popover
 * also holds the session's cost and its extensions' status lines, so the bar stays one short row.
 */
export function UsagePill({ harness, model, statuses, cost }: { harness?: string; model?: string; statuses?: Record<string, string>; cost?: number }) {
  const usage = useStore((s) => s.usage);
  const [open, setOpen] = useState(false);
  const prov = usageProvider(harness, model);
  const found = prov && usage?.providers.find((x) => x.provider === prov);
  const p = found && !found.error && found.windows.length ? found : undefined;
  const extra = Object.entries(statuses ?? {});
  const spent = cost != null && cost > 0 ? `$${cost.toFixed(2)}` : undefined;
  if (!p && !extra.length && !spent) return null;
  let text = spent ?? "Status";
  let worst: Level = "ok";
  if (p) {
    // Claude/Codex collapse to their 5h/weekly windows; providers without them (Kiro's credit pool) show all.
    const windowed = p.windows.filter((w) => w.label === "5h" || w.label === "Weekly");
    const main = windowed.length ? windowed : p.windows;
    worst = level(Math.max(...main.map((w) => w.percent ?? 0)));
    text = main.map((w) => (hasAmounts(w) ? `${short(w.label)} ${fmtNum(w.used)}/${fmtNum(w.limit)}` : `${short(w.label)} ${w.percent ?? "–"}%`)).join(" · ");
  }
  const name = p ? `${p.label} plan usage` : "Session cost and status";
  const content = (
    <VStack gap={3}>
      {(spent || extra.length > 0) && <SessionDetails statuses={extra} spent={spent} />}
      {p && <AllUsage />}
    </VStack>
  );
  return (
    <Popover label={name} content={content} isOpen={open} onOpenChange={setOpen} placement="above" alignment="end" width={300}>
      <Button
        label={`${name}: ${text}`}
        variant="ghost"
        size="sm"
        tooltip={name}
        icon={worst === "ok" ? undefined : <StatusDot variant={worst === "crit" ? "error" : "warning"} label={worst === "crit" ? "Near the limit" : "Getting close to the limit"} />}
      >
        <Text type="inherit" hasTabularNumbers>
          {text}
        </Text>
      </Button>
    </Popover>
  );
}
