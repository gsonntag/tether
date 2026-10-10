import type { CSSProperties } from "react";
import { HStack } from "@astryxdesign/core/HStack";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { VStack } from "@astryxdesign/core/VStack";
import { modelDisplay } from "../models";
import type { LiveState } from "../shared/protocol";

const bar: CSSProperties = { width: "var(--spacing-12)" };
const warnText: CSSProperties = { color: "var(--color-text-yellow)" };
const errorText: CSSProperties = { color: "var(--color-text-red)" };

/** 84k, 1.2M: short token counts for the status bar. */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

const exact = (n: number) => n.toLocaleString();

/** Status-bar meter: how full the model's context window is ("84k / 200k"), warning past 80%. */
export function ContextMeter({ state }: { state: LiveState }) {
  const c = state.context;
  // Older runners only send a percentage.
  if (!c) {
    const p = state.contextPercent;
    if (p == null) return null;
    return (
      <Tooltip content="Context window used">
        <HStack gap={1} vAlign="center" paddingInline={1}>
          <Text type="supporting" hasTabularNumbers>
            ctx {Math.round(p)}%
          </Text>
          <ProgressBar label="Context window used" isLabelHidden value={Math.min(100, p)} variant={p >= 95 ? "error" : p >= 80 ? "warning" : "accent"} style={bar} />
        </HStack>
      </Tooltip>
    );
  }
  if (c.used === undefined && c.max === undefined) return null;
  const pct = c.used !== undefined && c.max ? (c.used / c.max) * 100 : undefined;
  const variant = pct === undefined ? "neutral" : pct >= 95 ? "error" : pct >= 80 ? "warning" : "accent";
  const text = c.max ? `${c.used !== undefined ? fmtTokens(c.used) : "–"} / ${fmtTokens(c.max)}` : `${fmtTokens(c.used!)} ctx`;
  const breakdown = [
    c.input !== undefined && `${exact(c.input)} uncached input`,
    c.cacheRead !== undefined && `${exact(c.cacheRead)} cache read`,
    c.cacheWrite !== undefined && `${exact(c.cacheWrite)} cache write`,
  ].filter(Boolean);
  const tip = (
    <VStack gap={0.5}>
      <Text type="inherit" weight="semibold">
        Context window
      </Text>
      <Text type="inherit" hasTabularNumbers>
        {c.used !== undefined ? `${exact(c.used)} tokens` : "Unknown until the next reply (just compacted)"}
        {c.max ? ` of ${exact(c.max)}${c.maxEstimated ? " (estimated)" : ""}` : ""}
        {pct !== undefined ? ` · ${pct < 1 && pct > 0 ? "<1" : Math.round(pct)}%` : ""}
      </Text>
      {breakdown.length > 0 && (
        <Text type="inherit" hasTabularNumbers>
          {breakdown.join(" · ")}
        </Text>
      )}
      {c.model && <Text type="inherit">Model: {modelDisplay(c.model).name}</Text>}
    </VStack>
  );
  return (
    <Tooltip content={tip}>
      <HStack gap={1} vAlign="center" paddingInline={1}>
        <Text type="supporting" hasTabularNumbers style={variant === "error" ? errorText : variant === "warning" ? warnText : undefined}>
          {text}
        </Text>
        {pct !== undefined && <ProgressBar label="Context window used" isLabelHidden value={Math.min(100, pct)} variant={variant} style={bar} />}
      </HStack>
    </Tooltip>
  );
}
