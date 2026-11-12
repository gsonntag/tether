// Short links (store.ts): the browser's end. The web app, on `#/l/<code>`, asks each runner what
// the code opens; this one answers for the codes it handed out. The web app also shows every
// session it opens as its short link, and asks for the code here (linkFor). The store itself is made in the
// runner's entry (one for the whole runner, like homeLine) so texting can make links with it.

import type { Module } from "..";

export const linksModule: Module = {
  name: "links",
  start(ctx) {
    ctx.ops.register("resolveLink", ({ code }) => {
      const hit = ctx.links?.resolve(code);
      return hit ? { sessionId: hit.sessionId } : null;
    });
    ctx.ops.register("linkFor", ({ sessionId }) => {
      if (typeof sessionId !== "string" || !sessionId || sessionId.length > 512) return null;
      const code = ctx.links?.codeFor(sessionId);
      return code ? { code } : null;
    });
  },
};
