// A Discord bot as a connector (connector.ts): the person DMs the bot, or writes in one server
// channel set here, and it's the same as texting Tether (the Home agent, session numbers, y or n to a
// request). Only the owner user ids set here drive it: everyone else, other bots, webhooks and the
// bot itself are ignored, in DMs and in the channel, without a word. Tether's messages go to the
// first owner's DMs, and to the channel only while the person last wrote there (others in a channel
// can read it); where they last wrote is kept with the settings (`where`), so a restart doesn't move
// it. Long messages are split at Discord's 2000 characters, and a masked link ([text](url)) is
// spelled out so an agent can't disguise one. Files the person sends come in (fetched from
// Discord's CDN only, when a session takes them); images go out as attachments.
//
// Settings: texting.json `connectors.discord` (mode 600): { enabled, token, ownerIds, channelId,
// where }; runner.env wins: TETHER_DISCORD_TOKEN, TETHER_DISCORD_OWNER_IDS (comma-separated),
// TETHER_DISCORD_CHANNEL_ID, taken out of the runner's environment when it loads so no agent it
// starts can read the token. The token never leaves the runner (settings shows only "Set").

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { FROM_DISCORD } from "../../../../shared/fromTether";
import { cleanMime } from "../../../../shared/attachments";
import { ATTACH_FILE_MAX } from "../../../../shared/limits";
import type { ConnectorForm } from "../../../../shared/protocol";
import { registerSecret } from "../../credentials";
import type { Connector, Inbound, InboundFile } from "./connector";
import { download, Gateway, MESSAGE_MAX, Rest, type GatewayOptions } from "./discordGateway";
import type { TextingStore } from "./store";

export const DISCORD = "discord";

export interface DiscordSettings {
  enabled?: boolean;
  token?: string;
  ownerIds?: string[];
  channelId?: string;
  /** where the person last wrote: Tether's messages go there (a DM only while its owner still is one) */
  where?: Where;
}

export type Where = { kind: "dm"; id: string; owner: string } | { kind: "channel"; id: string };

/** What the link needs. */
export interface DiscordConfig {
  token: string;
  ownerIds: string[];
  channelId?: string;
}

/** The transport, for tests. */
export interface DiscordDeps {
  fetch?: typeof fetch;
  gateway?: GatewayOptions;
  apiUrl?: string;
}

export const SNOWFLAKE = /^\d{5,25}$/;
const isId = (x: unknown): x is string => typeof x === "string" && SNOWFLAKE.test(x);
const ids = (v: string | undefined) => (v ?? "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

/** Saved settings as they may be trusted: anything malformed (a hand-edited file) is left out. */
export function cleanSettings(v: unknown): DiscordSettings {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const out: DiscordSettings = {};
  if (typeof o.enabled === "boolean") out.enabled = o.enabled;
  if (typeof o.token === "string" && o.token.trim()) out.token = o.token.trim();
  if (Array.isArray(o.ownerIds)) {
    const list = o.ownerIds.filter(isId);
    if (list.length) out.ownerIds = list;
  }
  if (isId(o.channelId)) out.channelId = o.channelId;
  const w = o.where as Record<string, unknown> | undefined;
  if (w && typeof w === "object" && isId(w.id)) {
    if (w.kind === "channel") out.where = { kind: "channel", id: w.id };
    else if (w.kind === "dm" && isId(w.owner)) out.where = { kind: "dm", id: w.id, owner: w.owner };
  }
  return out;
}

const ENV_KEYS = ["TETHER_DISCORD_TOKEN", "TETHER_DISCORD_OWNER_IDS", "TETHER_DISCORD_CHANNEL_ID"] as const;
type DiscordEnv = Partial<Record<(typeof ENV_KEYS)[number], string>>;

/** The Discord settings in an environment, taken out of it (so nothing started from it inherits the token). */
export function takeEnv(env: Record<string, string | undefined>): DiscordEnv {
  const out: DiscordEnv = {};
  for (const k of ENV_KEYS) {
    if (env[k] !== undefined) out[k] = env[k];
    delete env[k];
  }
  return out;
}

/** The runner's own, taken when this loads: before any agent or harness is started. */
const PROCESS_ENV = takeEnv(process.env);

/** "[docs](https://x)" → "docs (https://x)": what a link says and where it goes, both shown. The rest of the markdown stays. */
export function unmask(text: string): string {
  return text.replace(/\[([^\[\]\n]*)\]\(\s*<?([^\s()<>]+)>?(?:\s+"[^"\n]*")?\s*\)/g, (_, label: string, url: string) => (label.trim() ? `${label} (${url})` : url));
}

/**
 * Splits a message into parts of at most `max` characters (UTF-16 units, as Discord counts), at a
 * line break or a space when there's one, never inside a surrogate pair. Blank parts are dropped:
 * nothing to send gives none.
 */
export function splitMessage(text: string, max = MESSAGE_MAX): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n");
    if (cut < max / 2) cut = Math.max(cut, window.lastIndexOf(" "));
    if (cut < max / 4) {
      cut = max;
      // Not between the two halves of an emoji.
      const c = rest.charCodeAt(cut - 1);
      if (c >= 0xd800 && c <= 0xdbff) cut--;
    }
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^[\n ]/, "");
  }
  parts.push(rest);
  return parts.filter((p) => p.trim());
}

/** Who may drive the bot, and where. */
export interface Audience {
  /** the bot's own user id */
  selfId?: string;
  ownerIds: string[];
  /** the server channel it listens in, besides DMs */
  channelId?: string;
}

/**
 * A MESSAGE_CREATE's message, when it's the person's: from an owner (not a bot, a webhook or the bot
 * itself), in a DM or in the set channel, a plain message or a reply. Undefined for anything else.
 */
export function personMessage(d: any, who: Audience): { text: string; id: string; author: string; channelId: string; dm: boolean; replyTo?: string; attachments: any[] } | undefined {
  if (!d || typeof d !== "object" || !d.author) return undefined;
  if (d.type !== undefined && d.type !== 0 && d.type !== 19) return undefined;
  if (d.author.bot || d.author.system || d.webhook_id) return undefined;
  const author = String(d.author.id);
  if (author === who.selfId || !who.ownerIds.includes(author)) return undefined;
  const channelId = String(d.channel_id ?? "");
  const dm = !d.guild_id;
  if (!dm && (!who.channelId || channelId !== who.channelId)) return undefined;
  // "@Tether 2 yes" in the channel: the mention isn't part of what they said.
  let text = typeof d.content === "string" ? d.content : "";
  if (who.selfId) text = text.replace(new RegExp(`^\\s*<@!?${who.selfId}>\\s*`), "");
  // A reply in this same channel names what it answers; a forward (type 1) or a cross-channel reference doesn't.
  const ref = d.message_reference;
  const replyTo = ref?.message_id && (ref.type === undefined || ref.type === 0) && String(ref.channel_id) === channelId ? String(ref.message_id) : undefined;
  return { text, id: String(d.id), author, channelId, dm, ...(replyTo ? { replyTo } : {}), attachments: Array.isArray(d.attachments) ? d.attachments : [] };
}

export function discordConnector(store: TextingStore, deps: DiscordDeps = {}): Connector {
  const env: DiscordEnv = store.env === process.env ? PROCESS_ENV : store.env;
  const saved = () => cleanSettings(store.section<DiscordSettings>(DISCORD));
  const envToken = () => env.TETHER_DISCORD_TOKEN?.trim() || undefined;
  const envOwners = () => ids(env.TETHER_DISCORD_OWNER_IDS).filter(isId);
  const envChannel = () => (isId(env.TETHER_DISCORD_CHANNEL_ID?.trim()) ? env.TETHER_DISCORD_CHANNEL_ID!.trim() : undefined);
  /** Remembers where the person last wrote (saved, so a restart keeps it). */
  const remember = (w: Where) => {
    const now = saved();
    if (JSON.stringify(now.where) !== JSON.stringify(w)) store.setSection(DISCORD, { ...now, where: w });
  };
  const token = () => envToken() ?? saved().token;
  const owners = () => (envOwners().length ? envOwners() : (saved().ownerIds ?? []));
  const channel = () => envChannel() ?? saved().channelId;
  for (const k of [saved().token, envToken()]) if (k) registerSecret(k);

  const config = (): DiscordConfig | undefined => {
    const t = token();
    const o = owners();
    return t && o.length ? { token: t, ownerIds: o, ...(channel() ? { channelId: channel() } : {}) } : undefined;
  };

  return {
    id: DISCORD,
    label: "Discord",
    mark: FROM_DISCORD,
    images: true,
    about:
      "Message your Discord bot in a DM (or in one server channel) the same as texting Tether: the Home agent, session numbers, y or n to a request. Only the user IDs set here can drive it; anyone else, and other bots, are ignored. Tether writes to your DMs, and in the channel only while you last wrote there.",
    notReady: "Set the bot token and your Discord user ID first, and turn Discord on.",
    enabled: () => saved().enabled ?? (!!envToken() && envOwners().length > 0),
    configured: () => !!config(),
    async open(onInbound, log) {
      const cfg = config();
      if (!cfg) throw new Error("not set up");
      const rest = new Rest(cfg.token, deps.fetch ?? fetch, deps.apiUrl);
      const fetcher = deps.fetch ?? fetch;
      let dm: Promise<string> | undefined;
      const gateway = new Gateway(
        cfg.token,
        (type, d) => {
          if (type !== "MESSAGE_CREATE") return;
          const m = personMessage(d, { selfId: gateway.self?.id, ownerIds: cfg.ownerIds, channelId: cfg.channelId });
          if (!m) return;
          remember(m.dm ? { kind: "dm", id: m.channelId, owner: m.author } : { kind: "channel", id: m.channelId });
          const files: InboundFile[] = m.attachments
            .filter((a) => typeof a?.url === "string")
            .map((a) => ({
              name: String(a.filename ?? "file"),
              mimeType: cleanMime(a.content_type, String(a.filename ?? "")),
              ...(typeof a.size === "number" ? { size: a.size } : {}),
              read: (max = ATTACH_FILE_MAX) => download(a.url, max, fetcher),
            }));
          const msg: Inbound = {
            text: m.text,
            id: m.id,
            ...(m.replyTo ? { replyTo: m.replyTo } : {}),
            ...(files.length ? { files } : {}),
            react: (emoji) => rest.react(m.channelId, m.id, emoji),
          };
          onInbound(msg);
        },
        { log, ...deps.gateway },
      );
      await gateway.start();
      /** Where Tether writes: where the person last wrote, while that's still allowed (the set channel, an owner's DM); else the first owner's DMs. */
      const target = async (): Promise<string> => {
        const w = saved().where;
        if (w?.kind === "channel" && w.id === cfg.channelId) return w.id;
        if (w?.kind === "dm" && cfg.ownerIds.includes(w.owner)) return w.id;
        const owner = cfg.ownerIds[0]!;
        const id = await (dm ??= rest.dm(owner).catch((e) => ((dm = undefined), Promise.reject(e))));
        remember({ kind: "dm", id, owner });
        return id;
      };

      const link = {
        async send(out: { text: string; images?: string[] }) {
          const files = (out.images ?? []).map((p) => ({ name: basename(p), data: new Uint8Array(readFileSync(p)), type: cleanMime(undefined, p) }));
          const parts = splitMessage(unmask(out.text));
          if (!parts.length && !files.length) return [];
          if (!parts.length) parts.push("");
          const to = await target();
          const sent: string[] = [];
          for (const [i, part] of parts.entries()) {
            const id = await rest.post(to, part, i === parts.length - 1 ? files : []);
            if (id) sent.push(id);
          }
          return sent;
        },
        closed: gateway.closed.then(() => {
          if (gateway.fatal) link.fatal = gateway.fatal;
        }),
        fatal: undefined as string | undefined,
        async stop() {
          gateway.stop();
        },
      };
      return link;
    },
    forms(): ConnectorForm[] {
      const s = saved();
      const fromEnvToken = !!envToken();
      const fromEnvOwners = envOwners().length > 0;
      const fromEnvChannel = !!envChannel();
      const envNote = (on: boolean) => (on ? " · from runner.env" : "");
      return [
        {
          key: "token",
          label: "Bot token",
          status: token() ? `Set${envNote(fromEnvToken)}` : "Not set",
          fromEnv: fromEnvToken,
          inputs: [{ key: "token", placeholder: "Bot token", secret: true }],
          unset: !!s.token && !fromEnvToken,
          note: "Developer Portal, your app, Bot: Reset Token, and turn on Message Content Intent.",
        },
        {
          key: "owners",
          label: "Your Discord user ID",
          status: owners().length ? `${owners().join(", ")}${envNote(fromEnvOwners)}` : "Not set",
          fromEnv: fromEnvOwners,
          inputs: [{ key: "ownerIds", placeholder: "User ID (commas for more)" }],
          unset: !!s.ownerIds?.length && !fromEnvOwners,
          note: "Only these users can drive the bot. In Discord: Settings, Advanced, Developer Mode, then right-click your name and Copy User ID.",
        },
        {
          key: "channel",
          label: "Server channel",
          status: channel() ? `${channel()}${envNote(fromEnvChannel)}` : "DMs only",
          fromEnv: fromEnvChannel,
          inputs: [{ key: "channelId", placeholder: "Channel ID (optional)", optional: true }],
          unset: !!s.channelId && !fromEnvChannel,
          note: "Tether answers there only while you last wrote there. Anyone who can see the channel can read what it posts.",
        },
      ];
    },
    update(a) {
      const next: DiscordSettings = { ...saved() };
      if (typeof a.enabled === "boolean") next.enabled = a.enabled;
      const v = a.values ?? {};
      if (typeof v.token === "string") {
        const t = v.token.trim().replace(/^Bot\s+/i, "");
        if (t && !/^[A-Za-z0-9._-]{20,200}$/.test(t)) throw new Error("That doesn't look like a bot token. Copy it again from the Developer Portal (Bot, Reset Token).");
        next.token = t || undefined;
        if (t) registerSecret(t);
      }
      if (typeof v.ownerIds === "string") {
        const list = ids(v.ownerIds);
        if (list.some((x) => !SNOWFLAKE.test(x)) || list.length > 10) throw new Error("A Discord user ID is a long number, like 123456789012345678.");
        next.ownerIds = list.length ? [...new Set(list)] : undefined;
      }
      if (typeof v.channelId === "string") {
        const c = v.channelId.trim();
        if (c && !SNOWFLAKE.test(c)) throw new Error("A Discord channel ID is a long number, like 123456789012345678.");
        next.channelId = c || undefined;
      }
      store.setSection(DISCORD, next);
    },
  };
}
