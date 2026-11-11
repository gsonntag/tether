// A Discord bot as a connector (connector.ts): the person DMs the bot, or writes in one server
// channel set here, and it's the same as texting Tether (the Home agent, session numbers, y or n to a
// request). Only the owner user ids set here drive it: everyone else, other bots, webhooks and the
// bot itself are ignored, in DMs and in the channel, without a word. Tether's messages go where the
// person last wrote; before that, to the channel when one is set, else to the first owner's DMs.
// Long messages are split at Discord's 2000 characters. Files the person sends come in (fetched
// from Discord's CDN when a session takes them); images go out as attachments.
//
// Settings: texting.json `connectors.discord` (mode 600): { enabled, token, ownerIds, channelId };
// runner.env wins: TETHER_DISCORD_TOKEN, TETHER_DISCORD_OWNER_IDS (comma-separated),
// TETHER_DISCORD_CHANNEL_ID. The token never leaves the runner (settings shows only "Set").

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { FROM_DISCORD } from "../../../../shared/fromTether";
import { cleanMime } from "../../../../shared/attachments";
import type { ConnectorForm } from "../../../../shared/protocol";
import { registerSecret } from "../../credentials";
import type { Connector, Inbound, InboundFile } from "./connector";
import { Gateway, MESSAGE_MAX, Rest, type GatewayOptions } from "./discordGateway";
import type { TextingStore } from "./store";

export const DISCORD = "discord";

export interface DiscordSettings {
  enabled?: boolean;
  token?: string;
  ownerIds?: string[];
  channelId?: string;
}

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

const SNOWFLAKE = /^\d{15,22}$/;
const ids = (v: string | undefined) => (v ?? "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

/** Splits a message into parts of at most `max` characters, at a line break or a space when there's one. */
export function splitMessage(text: string, max = MESSAGE_MAX): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n");
    if (cut < max / 2) cut = Math.max(cut, window.lastIndexOf(" "));
    if (cut < max / 4) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^[\n ]/, "");
  }
  if (rest.trim() || !parts.length) parts.push(rest);
  return parts;
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
export function personMessage(d: any, who: Audience): { text: string; id: string; channelId: string; replyTo?: string; attachments: any[] } | undefined {
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
  const replyTo = d.message_reference?.message_id ? String(d.message_reference.message_id) : undefined;
  return { text, id: String(d.id), channelId, ...(replyTo ? { replyTo } : {}), attachments: Array.isArray(d.attachments) ? d.attachments : [] };
}

export function discordConnector(store: TextingStore, deps: DiscordDeps = {}): Connector {
  const env = store.env;
  const saved = () => store.section<DiscordSettings>(DISCORD);
  const envToken = () => env.TETHER_DISCORD_TOKEN?.trim() || undefined;
  const envOwners = () => ids(env.TETHER_DISCORD_OWNER_IDS);
  const envChannel = () => env.TETHER_DISCORD_CHANNEL_ID?.trim() || undefined;
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
      "Message your Discord bot in a DM (or in one server channel) the same as texting Tether: the Home agent, session numbers, y or n to a request. Only the user IDs set here can drive it; anyone else, and other bots, are ignored.",
    notReady: "Set the bot token and your Discord user ID first, and turn Discord on.",
    enabled: () => saved().enabled ?? (!!envToken() && envOwners().length > 0),
    configured: () => !!config(),
    async open(onInbound, log) {
      const cfg = config();
      if (!cfg) throw new Error("not set up");
      const rest = new Rest(cfg.token, deps.fetch ?? fetch, deps.apiUrl);
      const fetcher = deps.fetch ?? fetch;
      /** where Tether's messages go: where the person last wrote */
      let where: string | undefined;
      let dm: Promise<string> | undefined;
      const gateway = new Gateway(
        cfg.token,
        (type, d) => {
          if (type !== "MESSAGE_CREATE") return;
          const m = personMessage(d, { selfId: gateway.self?.id, ownerIds: cfg.ownerIds, channelId: cfg.channelId });
          if (!m) return;
          where = m.channelId;
          const files: InboundFile[] = m.attachments
            .filter((a) => typeof a?.url === "string")
            .map((a) => ({
              name: String(a.filename ?? "file"),
              mimeType: cleanMime(a.content_type, String(a.filename ?? "")),
              ...(typeof a.size === "number" ? { size: a.size } : {}),
              read: async () => {
                const r = await fetcher(a.url);
                if (!r.ok) throw new Error(`Discord answered ${r.status} for ${a.filename}`);
                return new Uint8Array(await r.arrayBuffer());
              },
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
      const target = async () => where ?? cfg.channelId ?? (await (dm ??= rest.dm(cfg.ownerIds[0]!).catch((e) => ((dm = undefined), Promise.reject(e)))));

      const link = {
        async send(out: { text: string; images?: string[] }) {
          const to = await target();
          const parts = splitMessage(out.text);
          const files = (out.images ?? []).map((p) => ({ name: basename(p), data: new Uint8Array(readFileSync(p)), type: cleanMime(undefined, p) }));
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
      const env = (on: boolean) => (on ? " · from runner.env" : "");
      return [
        {
          key: "token",
          label: "Bot token",
          status: token() ? `Set${env(fromEnvToken)}` : "Not set",
          fromEnv: fromEnvToken,
          inputs: [{ key: "token", placeholder: "Bot token", secret: true }],
          unset: !!s.token && !fromEnvToken,
          note: "Developer Portal, your app, Bot: Reset Token, and turn on Message Content Intent.",
        },
        {
          key: "owners",
          label: "Your Discord user ID",
          status: owners().length ? `${owners().join(", ")}${env(fromEnvOwners)}` : "Not set",
          fromEnv: fromEnvOwners,
          inputs: [{ key: "ownerIds", placeholder: "User ID (commas for more)" }],
          unset: !!s.ownerIds?.length && !fromEnvOwners,
          note: "Only these users can drive the bot. In Discord: Settings, Advanced, Developer Mode, then right-click your name and Copy User ID.",
        },
        {
          key: "channel",
          label: "Server channel",
          status: channel() ? `${channel()}${env(fromEnvChannel)}` : "DMs only",
          fromEnv: fromEnvChannel,
          inputs: [{ key: "channelId", placeholder: "Channel ID (optional)", optional: true }],
          unset: !!s.channelId && !fromEnvChannel,
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
