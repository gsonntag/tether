// Astryx's Markdown with Tether's defaults: remote images never load by themselves (they show as
// "Load image … from <host>", RemoteImage). Every markdown in the app goes through this, so no
// caller can forget. When streaming animation is disabled (streamingAnimation === false), text
// renders with speed="instant" to bypass main-thread tick loops and fade animations on huge sessions.

import type { ComponentProps } from "react";
import { Markdown as AstryxMarkdown } from "@astryxdesign/core/Markdown";
import { RemoteImage } from "./RemoteImage";
import { useSessionCtx } from "./sessionContext";

type Props = ComponentProps<typeof AstryxMarkdown>;

export function Markdown({ components, speed, isStreaming, ...props }: Props) {
  const { streamingAnimation } = useSessionCtx();
  const effectiveSpeed = speed ?? (streamingAnimation === false && isStreaming ? "instant" : undefined);
  return (
    <AstryxMarkdown
      {...props}
      isStreaming={isStreaming}
      speed={effectiveSpeed}
      components={{ image: RemoteImage, ...components } as Props["components"]}
    />
  );
}
