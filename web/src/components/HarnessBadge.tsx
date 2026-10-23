import { useId, type ComponentProps, type SVGProps } from "react";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import type { HarnessId } from "../shared/protocol";
import { badge, harnessLabel } from "../util";

type TokenColor = NonNullable<ComponentProps<typeof Token>["color"]>;

const COLORS: Record<HarnessId, TokenColor> = {
  "claude-code": "orange",
  codex: "green",
  pi: "purple",
  opencode: "gray",
  kiro: "purple",
  antigravity: "blue",
};

/** Logo files in public/logos; "mask" ones are single-color and take the token's ink via an alpha mask. */
const LOGOS: Partial<Record<HarnessId, { src: string; mask?: boolean }>> = {
  "claude-code": { src: "/logos/anthropic.svg", mask: true },
  codex: { src: "/logos/openai.svg", mask: true },
  pi: { src: "/logos/pi.svg" },
  opencode: { src: "/logos/opencode.svg", mask: true },
};

function logoIcon(src: string, mask?: boolean) {
  return function Logo(props: SVGProps<SVGSVGElement>) {
    const id = useId();
    return (
      <svg viewBox="0 0 24 24" {...props}>
        {mask ? (
          <>
            <mask id={id} style={{ maskType: "alpha" }}>
              <image href={src} width="24" height="24" />
            </mask>
            <rect width="24" height="24" fill="currentColor" mask={`url(#${id})`} />
          </>
        ) : (
          <image href={src} width="24" height="24" />
        )}
      </svg>
    );
  };
}

const ICONS = Object.fromEntries(Object.entries(LOGOS).map(([h, l]) => [h, logoIcon(l.src, l.mask)])) as Partial<
  Record<HarnessId, ReturnType<typeof logoIcon>>
>;

export function HarnessBadge({ harness }: { harness: HarnessId }) {
  const color = COLORS[harness] ?? "default";
  const logo = ICONS[harness];
  if (!logo) return <Token size="sm" color={color} label={badge(harness)} />;
  return (
    <Tooltip content={harnessLabel(harness)} hasHoverIndication={false}>
      <Token size="sm" color={color} label={harnessLabel(harness)} isLabelHidden icon={<Icon icon={logo} size="xsm" />} />
    </Tooltip>
  );
}

/** 14px, between the icon scale's 12 and 16. */
const GLYPH = "calc(var(--spacing-3) + var(--spacing-1) / 2)";

/** The harness as a bare 14px mark (its logo, or its letters), for dense rows; its name in a tooltip. */
export function HarnessGlyph({ harness }: { harness: HarnessId }) {
  const Logo = ICONS[harness];
  const name = harnessLabel(harness);
  return (
    <Tooltip content={name} hasHoverIndication={false}>
      <HStack
        role="img"
        aria-label={name}
        vAlign="center"
        hAlign="center"
        style={{ width: GLYPH, height: GLYPH, flexShrink: 0, color: "var(--color-text-secondary)" }}
      >
        {Logo ? (
          <Logo width="100%" height="100%" aria-hidden />
        ) : (
          <Text type="supporting" size="3xs" weight="bold" color="secondary">
            {badge(harness)}
          </Text>
        )}
      </HStack>
    </Tooltip>
  );
}
