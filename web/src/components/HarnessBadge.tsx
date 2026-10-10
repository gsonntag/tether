import { useId, type ComponentProps, type SVGProps } from "react";
import { Icon } from "@astryxdesign/core/Icon";
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
