// "Fork from here": a new session in the same directory that has the conversation up to and
// including one message, on any harness and model, linked to the one it came from (forkedFrom).
// On the same harness, where the harness forks at a message point itself (Adapter.fork: Claude
// Code's forkSession, Codex's thread/fork), the new session is that native fork. Otherwise it is
// seeded with a brief of the conversation up to that point (handoff.ts buildBrief), with the
// relevant memories like a handoff. Kept out of index.ts, which connects on import, so tests can
// run it against stubbed adapters.

import { withAttachments, type Attachment } from "../../web/src/shared/attachments";
import type { HarnessId, Msg, Part } from "../../web/src/shared/protocol";
import { APPROVING_MODES, HARNESSES } from "../../web/src/shared/protocol";
import { displayText } from "../../web/src/shared/skill";
import type { Adapter, Sink } from "./adapters/types";
import { storeInlineImage } from "./attachments";
import { config, saveConfig } from "./config";
import type { ContextService } from "./context";
import { carriedNotice } from "./context/handoff";
import { buildBrief } from "./handoff";
import { entryLabel, tetherOnly, type LiveSession } from "./session";
import { resolveForBrief } from "./skillcmd";

export interface ForkDeps {
  adapters: Record<HarnessId, Pick<Adapter, "create" | "fork">>;
  sink: Sink;
  context: Pick<ContextService, "handoffMemory">;
  /** registers the new session as live (index.ts track) */
  track: (s: LiveSession) => void;
}

export interface ForkRequest {
  msgId: string;
  harness: HarnessId;
  model?: string;
  /** what the new session gets next (after the message it answers again, on a user message) */
  prompt?: string;
}

/**
 * A user message as it would be sent again: its skills as `/name`, its text, its attached files,
 * and `images`: its inline images, stored as files (storeImages).
 */
export function promptOf(m: Msg, images: Attachment[] = []): string {
  const skills = m.parts.flatMap((p) => (p.type === "skill" ? [`/${p.name}`] : []));
  const text = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n").trim();
  const files = m.parts.filter((p): p is Extract<Part, { type: "file" }> => p.type === "file").map(({ type: _, ...f }) => f);
  return withAttachments([...skills, text].filter(Boolean).join(" "), [...files, ...images]);
}

type ImagePart = Extract<Part, { type: "image" }>;
const imagesOf = (m: Msg) => m.parts.filter((p): p is ImagePart => p.type === "image");

/**
 * Images a harness kept inline in a user message (Claude Code, pi and ACP history), stored with
 * the session's attachments so the message can be sent again with them. Ones that can't be stored
 * are left out (and logged).
 */
export function storeImages(sessionId: string, m: Msg): Attachment[] {
  return imagesOf(m).flatMap((p, i) => {
    try {
      return [storeInlineImage(sessionId, `image-${i + 1}`, p.mimeType, p.data)];
    } catch (e: any) {
      console.error(`fork: an image of ${m.id} wasn't stored: ${e?.message ?? e}`);
      return [];
    }
  });
}

/**
 * Where a fork at `msgId` cuts: `kept` is what the new session has. On a user message the fork keeps
 * what came before it and `ask` is that message, sent again (so the new agent answers it); on any
 * other message the fork keeps it too. `later`: the conversation went on after the message.
 */
export function forkCut(messages: Msg[], msgId: string): { kept: Msg[]; ask?: string; later: boolean; at: Msg } | undefined {
  const i = messages.findIndex((m) => m.id === msgId);
  if (i < 0) return undefined;
  const at = messages[i]!;
  const later = messages.slice(i + 1).some((m) => !tetherOnly(m));
  const ask = at.role === "user" ? promptOf(at) : "";
  // An image-only message is asked again too (runFork adds its images).
  if (ask || (at.role === "user" && imagesOf(at).length)) return { kept: messages.slice(0, i), ask, later, at };
  return { kept: messages.slice(0, i + 1), later, at };
}

/** "at “Fix the login…”": where the fork was made, for the link back. */
export function forkReason(at: Msg): string {
  const text = displayText(at.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(" ")).replace(/\s+/g, " ").trim();
  if (!text) return at.role === "user" ? "at one of your messages" : "at one of its replies";
  if (text.length <= 60) return `at “${text}”`;
  const cut = text.slice(0, 60);
  const word = cut.lastIndexOf(" ");
  return `at “${(word > 40 ? cut.slice(0, word) : cut).trimEnd()}…”`;
}

const harnessLabel = (h: HarnessId) => HARNESSES.find((x) => x.id === h)?.label ?? h;

/**
 * The fork's model and credential. A model picked with its credential ("id#azure:east", modelKey)
 * runs there; a model without one runs on the harness's own login; no model at all (Default) keeps
 * the session's credential when the harness stays the same.
 */
export function forkModel(req: { harness: HarnessId; model?: string }, fromHarness: HarnessId, fromCredential?: string): { model?: string; credential?: string } {
  const hash = req.model?.indexOf("#") ?? -1;
  const picked = hash >= 0 ? req.model!.slice(0, hash) : req.model;
  const named = hash >= 0 ? req.model!.slice(hash + 1).trim() : undefined;
  const credential = req.model ? named || undefined : req.harness === fromHarness ? fromCredential : undefined;
  const model = picked && picked !== "default" ? picked : undefined;
  return { ...(model ? { model } : {}), ...(credential ? { credential } : {}) };
}

/** Forks `from` at a message into a new live session (started, tracked, its first turn on its way). */
export async function runFork(deps: ForkDeps, from: LiveSession, req: ForkRequest): Promise<LiveSession> {
  const { sink, context } = deps;
  const a = deps.adapters[req.harness];
  if (!a) throw new Error(`Unknown harness ${req.harness}`);
  const cut = forkCut(from.t.messages, req.msgId);
  if (!cut) throw new Error("That message isn't in this session any more.");
  const { model, credential } = forkModel(req, from.harness, from.t.state.credential);
  const ask = cut.ask !== undefined && imagesOf(cut.at).length ? promptOf(cut.at, storeImages(from.id, cut.at)) : cut.ask;
  const prompt = [ask, req.prompt?.trim()].filter(Boolean).join("\n\n") || undefined;
  const reason = forkReason(cut.at);
  const sameHarness = req.harness === from.harness;
  const mode = sameHarness && from.t.state.permissionMode && !APPROVING_MODES.has(from.t.state.permissionMode) ? from.t.state.permissionMode : undefined;
  const opts = { model, permissionMode: mode };
  const history = cut.kept.some((m) => !tetherOnly(m));

  // The harness's own fork, where it cuts at this point.
  let next: LiveSession | undefined;
  // Not onto another credential: its history lives in the old one's home (an account's own
  // CLAUDE_CONFIG_DIR / CODEX_HOME), so that fork goes by a brief.
  const sameCredential = (credential ?? "") === (from.t.state.credential ?? "");
  const point = sameHarness && sameCredential && a.fork && history ? from.forkPoint(cut.kept.length) : undefined;
  if (point && a.fork) {
    try {
      next = await a.fork({ nativeId: from.nativeId, projectPath: from.projectPath, point }, opts, sink);
      next.t.state.guard = from.guardMode;
      if (credential) next.t.state.credential = credential;
      await next.start();
    } catch (e: any) {
      console.error(`fork of ${from.id}: the harness's own fork failed, using a brief: ${e?.message ?? e}`);
      next?.close();
      next = undefined;
    }
  }
  const native = !!next;

  // Otherwise a new session, given a brief of the conversation up to that point (nothing to brief
  // when the fork is at the very first message: the new session just gets it).
  let brief: string | undefined;
  let memory: Awaited<ReturnType<ForkDeps["context"]["handoffMemory"]>> = undefined;
  if (!next) {
    if (history) {
      memory = await context.handoffMemory({
        sessionId: from.id,
        projectPath: from.projectPath,
        messages: cut.kept,
        target: req.harness,
        pendingPrompt: prompt && displayText(prompt),
        // The source session goes on: what it learned is captured when it hands off itself.
        capture: false,
      });
      brief = await buildBrief({
        kind: "fork",
        messages: cut.kept,
        cwd: from.projectPath,
        fromLabel: `${harnessLabel(from.harness)}, ${entryLabel(from.currentEntry)}`,
        reason: `the user forked it ${reason}`,
        later: cut.later,
        // As typed: `/skill args` is resolved for the new harness.
        pendingPrompt: prompt === undefined ? undefined : resolveForBrief(req.harness, from.projectPath, prompt),
        memory: memory?.text,
      });
    }
    next = a.create(from.projectPath, opts, sink);
    next.t.state.guard = from.guardMode;
    if (credential) next.t.state.credential = credential;
    try {
      await next.start();
    } finally {
      memory?.settle?.();
    }
  }

  deps.track(next);
  // The conversation lists the earlier session's attachments: the new agent may read them too.
  next.inheritedAttachments = from.attachmentFolders();
  const title = `${from.title} (fork)`;
  config().titles[next.id] = title;
  saveConfig();
  next.setTitle(title);
  next.setState({ forkedFrom: { sessionId: from.id, reason }, guard: from.guardMode });
  if (model && next.t.state.model !== model) await next.applyModel(model);

  const onDisk = cut.later ? " The files on disk include the changes made after that point." : "";
  if (native) next.notice(`Forked from a ${harnessLabel(from.harness)} session ${reason}: ${harnessLabel(req.harness)} copied the conversation up to there.${onDisk}`, "info");
  else if (brief) {
    const carried = (memory?.carried.length ?? 0) + (memory?.captured.length ?? 0);
    if (memory && (carried || memory.native)) {
      const what = carried ? `${carried} ${carried === 1 ? "memory" : "memories"}` : "the shared memory";
      next.notice(
        `The agent was given the conversation up to there, the repository state and ${what}.${onDisk}\n\n${carriedNotice(memory, req.harness)}`,
        "info",
        { title: `Forked from a ${harnessLabel(from.harness)} session ${reason}. Carried ${what}.`, collapsed: true, source: "memory" },
      );
    } else next.notice(`Forked from a ${harnessLabel(from.harness)} session ${reason}. The agent was given the conversation up to there and the repository state.${onDisk}`, "info");
  } else next.notice(`Forked from a ${harnessLabel(from.harness)} session ${reason}. Nothing came before that point, so it starts from there.`, "info");

  if (brief) {
    if (prompt) next.addUserMessage(prompt);
    // Held open until the brief has reached the agent (the idle close waits).
    await next.hold(() => next.continueTurn(brief));
  } else if (prompt) await next.prompt(prompt);
  sink.summary(next.summary());
  return next;
}
