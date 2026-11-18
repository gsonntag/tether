// The files module (SPEC §10 Files): the Changes pane's Files tab reads the session's folder through
// it. listDir, readFile and findFiles only read, and only inside the folder (fs.ts says how). What
// they read is the folder itself (a .env's secrets too), so every op here needs drive access: none
// may ever be in a view-only list (shared/access.ts VIEW_OPS, on the branches that have it).

import type { Module } from "..";
import { Finder } from "./find";
import { listDir, readFile, realRoot } from "./fs";

export const filesModule: Module = {
  name: "files",
  start(ctx) {
    const finder = new Finder();
    const rootOf = async (sessionId: unknown) => {
      if (typeof sessionId !== "string" || !sessionId) throw new Error("sessionId is required.");
      const s = ctx.session(sessionId) ?? (await ctx.sessions.open(sessionId));
      return realRoot(s.summary.projectPath);
    };
    ctx.ops.register("listDir", async ({ sessionId, path, hidden }) => listDir(await rootOf(sessionId), path ?? "", hidden === true));
    ctx.ops.register("readFile", async ({ sessionId, path, maxBytes, head }) =>
      readFile(await rootOf(sessionId), path, { ...(typeof maxBytes === "number" ? { maxBytes } : {}), head: head === true }),
    );
    ctx.ops.register("findFiles", async ({ sessionId, query, hidden, fresh }) => {
      if (typeof query !== "string") throw new Error("query is required.");
      return finder.find(await rootOf(sessionId), query.slice(0, 200), hidden === true, fresh === true);
    });
  },
};
