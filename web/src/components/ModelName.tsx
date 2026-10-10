import { useId, type ComponentProps, type SVGProps } from "react";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { CubeTransparentIcon } from "@heroicons/react/24/outline";
import { modelDisplay, PROVIDERS, type ModelDisplay, type ModelProvider } from "../models";

type IconSize = ComponentProps<typeof Icon>["size"];

/** A single-color logo from public/logos that takes the surrounding ink through an alpha mask. */
function maskIcon(src: string) {
  return function Logo(props: SVGProps<SVGSVGElement>) {
    const id = useId();
    return (
      <svg viewBox="0 0 24 24" {...props}>
        <mask id={id} style={{ maskType: "alpha" }}>
          <image href={src} width="24" height="24" />
        </mask>
        <rect width="24" height="24" fill="currentColor" mask={`url(#${id})`} />
      </svg>
    );
  };
}

const LOGOS = Object.fromEntries(
  Object.entries(PROVIDERS)
    .filter(([, p]) => p.logo)
    .map(([k, p]) => [k, maskIcon(p.logo!)]),
) as Partial<Record<ModelProvider, ReturnType<typeof maskIcon>>>;

/** The maker's logo (a plain cube for makers without one). */
export function modelIcon(d: ModelDisplay, size: IconSize = "sm") {
  const logo = d.provider && LOGOS[d.provider];
  return <Icon icon={logo ?? CubeTransparentIcon} size={size} color="secondary" />;
}

/** "Opus 5.5", "GPT-6 Luna (via azure)" — the tooltip shows the raw id. */
export function modelTooltip(d: ModelDisplay) {
  return [d.providerLabel, d.via && `via ${d.via}`, d.id].filter(Boolean).join(" · ");
}

/** Logo plus pretty name of a model id; hover for the raw id. */
export function ModelName({ id, harness, hasLogo = true }: { id: string | undefined; harness?: string; hasLogo?: boolean }) {
  const d = modelDisplay(id, harness);
  return (
    <Tooltip content={modelTooltip(d)} hasHoverIndication={false}>
      <HStack gap={1} vAlign="center">
        {hasLogo && modelIcon(d)}
        <Text type="inherit" maxLines={1}>
          {d.name}
        </Text>
      </HStack>
    </Tooltip>
  );
}
