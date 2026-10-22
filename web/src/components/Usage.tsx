import { useState } from "react";
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

/** Settings-bar pill: the 5h / weekly usage of the subscription this session runs on. */
export function UsagePill({ harness, model }: { harness?: string; model?: string }) {
  const usage = useStore((s) => s.usage);
  const [open, setOpen] = useState(false);
  const prov = usageProvider(harness, model);
  const p = prov && usage?.providers.find((x) => x.provider === prov);
  if (!p || p.error || !p.windows.length) return null;
  // Claude/Codex collapse to their 5h/weekly windows; providers without them (Kiro's credit pool) show all.
  const windowed = p.windows.filter((w) => w.label === "5h" || w.label === "Weekly");
  const main = windowed.length ? windowed : p.windows;
  const worst = level(Math.max(...main.map((w) => w.percent ?? 0)));
  const text = main.map((w) => (hasAmounts(w) ? `${short(w.label)} ${fmtNum(w.used)}/${fmtNum(w.limit)}` : `${short(w.label)} ${w.percent ?? "–"}%`)).join(" · ");
  return (
    <Popover label={`${p.label} plan usage`} content={<AllUsage />} isOpen={open} onOpenChange={setOpen} placement="above" alignment="end" width={300}>
      <Button
        label={`${p.label} plan usage: ${text}`}
        variant="ghost"
        size="sm"
        tooltip={`${p.label} plan usage`}
        icon={worst === "ok" ? undefined : <StatusDot variant={worst === "crit" ? "error" : "warning"} label={worst === "crit" ? "Near the limit" : "Getting close to the limit"} />}
      >
        <Text type="inherit" hasTabularNumbers>
          {text}
        </Text>
      </Button>
    </Popover>
  );
}
