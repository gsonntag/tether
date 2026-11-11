// Short links (store.ts): the browser's end. The web app, on `#/l/<code>`, asks each runner what
// the code opens; this one answers for the codes it handed out. The store itself is made in the
// runner's entry (one for the whole runner, like homeLine) so texting can make links with it.

import type { Module } from "..";

export const linksModule: Module = {
  name: "links",
  start(ctx) {
    ctx.ops.register("resolveLink", ({ code }) => {
      const hit = ctx.links?.resolve(code);
      return hit ? { runnerId: ctx.runnerId, sessionId: hit.sessionId } : null;
    });
  },
};
