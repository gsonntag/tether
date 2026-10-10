import { useState, type CSSProperties } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Stack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Token } from "@astryxdesign/core/Token";
import type { ConflictStatus, HarnessId, MemoryConflict } from "../shared/protocol";
import { resolveConflict, useStore } from "../store";
import { harnessLabel } from "../util";

// ---------- labels shared by the Memory & Skills page ----------

/** "global" → "Global"; "repo:github.com/me/app" → "app" (the full key is the tooltip). */
export function scopeLabel(scope: string): string {
  if (scope === "global") return "Global";
  const key = scope.replace(/^repo:/, "");
  return key.split("/").filter(Boolean).pop() ?? key;
}

/** Harness names used in provenance and skill sources ("claude", "gemini", …) → a Tether harness. */
const SOURCE_HARNESS: Record<string, HarnessId> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  codex: "codex",
  pi: "pi",
  opencode: "opencode",
  kiro: "kiro",
  gemini: "antigravity",
  antigravity: "antigravity",
};

export function sourceHarness(name: string): HarnessId | undefined {
  return SOURCE_HARNESS[name];
}

/** "claude:~/.claude/…/x.md" → "Claude Code"; "mcp:codex:…" → "Codex (MCP)"; "you" → "you". */
export function sourceLabel(source: string): string {
  const [kind, rest] = [source.slice(0, source.indexOf(":")), source.slice(source.indexOf(":") + 1)];
  if (!source.includes(":")) return source;
  if (kind === "mcp") {
    const h = sourceHarness(rest.split(":")[0] ?? "");
    return h ? `${harnessLabel(h)} (MCP)` : "an agent (MCP)";
  }
  const h = sourceHarness(kind);
  return h ? harnessLabel(h) : kind;
}

export const ts = (ms: number) => Math.floor(ms / 1000);

const STATUS_LABEL: Record<ConflictStatus, string> = {
  open: "Open",
  "kept-new": "Kept new",
  "kept-old": "Kept old",
  dismissed: "Dismissed",
};

const side = (tone: "old" | "new"): CSSProperties => ({
  borderInlineStart: `calc(var(--border-width) * 2) solid var(${tone === "old" ? "--color-border-red" : "--color-border-green"})`,
  paddingInlineStart: "var(--spacing-2)",
  minWidth: 0,
});
const preWrap: CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word" };

function Side({ title, claim, body, tone }: { title: string; claim?: string; body: string; tone: "old" | "new" }) {
  return (
    <VStack gap={1} style={side(tone)}>
      <Text type="supporting" weight="semibold" color="secondary">
        {title}
      </Text>
      <Text style={preWrap}>{claim || body}</Text>
      {claim && claim.trim() !== body.trim() && (
        <Collapsible trigger={<Text type="supporting">Full text</Text>} defaultIsOpen={false}>
          <Markdown density="compact">{body}</Markdown>
        </Collapsible>
      )}
    </VStack>
  );
}

/**
 * A memory that contradicted an older one: old vs new side by side. Newest already won; "Keep new"
 * (the default) just confirms it, "Keep old" restores the earlier version in one click.
 */
export function ConflictView({ c, isInline }: { c: MemoryConflict; isInline?: boolean }) {
  const narrow = useMediaQuery("(max-width: 640px)");
  const [busy, setBusy] = useState<string>();
  const run = async (action: "keep-new" | "keep-old" | "dismiss") => {
    setBusy(action);
    await resolveConflict(c.id, action);
    setBusy(undefined);
  };
  const open = c.status === "open";
  const body = (
    <VStack gap={3}>
      <VStack gap={0.5}>
        <HStack gap={2} vAlign="center">
          {open && <StatusDot variant="warning" label="Needs a look" />}
          <StackItem size="fill">
            <Text type="label" weight="semibold">
              {isInline ? `Memory changed: ${c.name}` : c.name}
            </Text>
          </StackItem>
          {!open && <Token size="sm" label={STATUS_LABEL[c.status]} />}
        </HStack>
        <Text type="supporting" color="secondary">
          {scopeLabel(c.scope)} · from {sourceLabel(c.source)} · <Timestamp value={ts(c.ts)} format="relative" type="inherit" />
          {open && " · This contradicts what was remembered before. The new version is in use."}
        </Text>
      </VStack>
      <Stack direction={narrow ? "vertical" : "horizontal"} gap={3} align="stretch">
        <StackItem size="fill">
          <Side title="Before" claim={c.oldClaim} body={c.oldBody} tone="old" />
        </StackItem>
        <StackItem size="fill">
          <Side title="Now" claim={c.newClaim} body={c.newBody} tone="new" />
        </StackItem>
      </Stack>
      {open && (
        <HStack gap={2} wrap="wrap">
          <Button label="Keep new" variant="primary" size="sm" isLoading={busy === "keep-new"} isDisabled={!!busy} onClick={() => run("keep-new")} />
          <Button label="Keep old" size="sm" isLoading={busy === "keep-old"} isDisabled={!!busy || !c.commit} onClick={() => run("keep-old")} />
          <Button label="Dismiss" variant="ghost" size="sm" isLoading={busy === "dismiss"} isDisabled={!!busy} onClick={() => run("dismiss")} />
        </HStack>
      )}
    </VStack>
  );
  return isInline ? (
    <Card width="100%" padding={3} variant="muted">
      {body}
    </Card>
  ) : (
    body
  );
}

/** Inline cards for the open conflicts this session produced (shown under its transcript). */
export function SessionConflicts({ sessionId }: { sessionId: string }) {
  const all = useStore((s) => s.conflicts);
  const mine = all.filter((c) => c.sessionId === sessionId);
  return (
    <>
      {mine.map((c) => (
        <ConflictView key={c.id} c={c} isInline />
      ))}
    </>
  );
}
