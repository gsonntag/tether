// Astryx's Markdown with Tether's defaults: remote images never load by themselves (they show as
// "Load image … from <host>", RemoteImage). Every markdown in the app goes through this, so no
// caller can forget.

import type { ComponentProps } from "react";
import { Markdown as AstryxMarkdown } from "@astryxdesign/core/Markdown";
import { RemoteImage } from "./RemoteImage";

type Props = ComponentProps<typeof AstryxMarkdown>;

export function Markdown({ components, ...props }: Props) {
  return <AstryxMarkdown {...props} components={{ image: RemoteImage, ...components } as Props["components"]} />;
}
