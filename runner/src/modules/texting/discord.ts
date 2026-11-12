// A Discord bot as a connector (connector.ts): the person DMs the bot, or writes in one server
// channel set here, and it's the same as texting Tether (the Home agent, session numbers, y or n to a
// request). Only the owner user ids set here drive it: everyone else, other bots, webhooks and the
// bot itself are ignored, in DMs and in the channel, without a word. In the channel only a message
// that starts by mentioning the bot, or replies to one of its messages, is for Tether (a "yes" to a
// coworker there mustn't approve anything). Tether's messages go to the owner's DMs; only an answer
// to something written in the channel goes there (others in the channel can read it). The DM is kept
// with the settings (`where`). Long messages are split at Discord's 2000 characters, and a masked link ([text](url)) is
// spelled out so an agent can't disguise one. Files the person sends come in (fetched from
// Discord's CDN only, when a session takes them). The link sends images as attachments
// (Outbound.images or .files): an agent's text_person image.
//
// Settings: texting.json `connectors.discord` (mode 600): { enabled, token, ownerIds, channelId,
// where }; runner.env wins: TETHER_DISCORD_TOKEN, TETHER_DISCORD_OWNER_IDS (comma-separated),
// TETHER_DISCORD_CHANNEL_ID, taken out of process.env when it loads; with childEnv.ts (every
// spawn passes a filtered env) the token isn't passed to agents' environments. Agents run as the same
// user and can read files, texting.json included; a token from runner.env also stays readable in
// /proc/<runner pid>/environ to same-user processes, so the settings page (texting.json, mode 600) is
// the better place for it. The token never goes to the web (settings shows only "Set").
//
// A mention of the bot's managed role (<@&role>, what Discord inserts when you pick the role instead of
// the bot user) isn't taken: it needs the GUILDS intent to tell that role apart. The settings hint says
// to mention the bot itself.

import { FROM_DISCORD } from "../../../../shared/fromTether";
import { cleanMime } from "../../../../shared/attachments";
import { ATTACH_FILE_MAX } from "../../../../shared/limits";
import { readOutgoingImage } from "./images";
import type { ConnectorForm } from "../../../../shared/protocol";
import { registerSecret } from "../../credentials";
import { PartialSend, type Connector, type Inbound, type InboundFile } from "./connector";
import { download, Gateway, keepIdentifies, MESSAGE_MAX, Rest, type GatewayOptions } from "./discordGateway";
import type { TextingStore } from "./store";

export const DISCORD = "discord";

export interface DiscordSettings {
  enabled?: boolean;
  token?: string;
  ownerIds?: string[];
  channelId?: string;
  /** the DM the person last wrote in: Tether's messages go there (while its owner still is one) */
  where?: Where;
  /** when the bot last started fresh sessions (identifies), for Discord's daily limit across restarts */
  identifies?: number[];
  /** owners' DM channels, by channel id: an answer to a DM goes back to that owner's, across reconnects */
  dms?: Record<string, string>;
}

export type Where = { kind: "dm"; id: string; owner: string };

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
    if (w.kind === "dm" && isId(w.owner)) out.where = { kind: "dm", id: w.id, owner: w.owner };
  }
  if (o.dms && typeof o.dms === "object" && !Array.isArray(o.dms)) {
    const dms = Object.fromEntries(Object.entries(o.dms as Record<string, unknown>).filter(([k, v]) => isId(k) && isId(v)).slice(-20)) as Record<string, string>;
    if (Object.keys(dms).length) out.dms = dms;
  }
  if (Array.isArray(o.identifies)) {
    const t = o.identifies.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).slice(-1000);
    if (t.length) out.identifies = t;
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

/**
 * "[docs](https://x)" → "docs (https://x)": what a link says and where it goes, both shown. Whatever
 * the simple form misses (nested brackets, parentheses in the URL, a line break in the text) can't
 * become a link either: every "](" left is escaped. The rest of the markdown stays.
 */
export function unmask(text: string): string {
  const plain = text.replace(/\[([^\[\]\n]*)\]\(\s*<?([^\s()<>]+)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g, (_, label: string, url: string) => (label.trim() ? `${label} (${url})` : url));
  return plain.replace(/\]\s*\(/g, (m) => `\\${m}`);
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
  /** whether a message id is one the bot posted (a reply to it in the channel is for Tether) */
  mine?: (messageId: string) => boolean;
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
  // A reply in this same channel names what it answers; a forward (type 1) or a cross-channel reference doesn't.
  const ref = d.message_reference;
  const replyTo = ref?.message_id && (ref.type === undefined || ref.type === 0) && String(ref.channel_id) === channelId ? String(ref.message_id) : undefined;
  // "@Tether 2 yes" in the channel: the mention isn't part of what they said.
  let text = typeof d.content === "string" ? d.content : "";
  const mention = who.selfId ? new RegExp(`^\\s*<@!?${who.selfId}>\\s*`) : undefined;
  const mentioned = !!mention && mention.test(text);
  if (mention) text = text.replace(mention, "");
  // In the channel, only what's addressed to the bot: a mention first, or a reply to one of its messages.
  if (!dm) {
    const toBot = !!replyTo && (String(d.referenced_message?.author?.id ?? "") === who.selfId || !!who.mine?.(replyTo));
    if (!mentioned && !toBot) return undefined;
  }
  return { text, id: String(d.id), author, channelId, dm, ...(replyTo ? { replyTo } : {}), attachments: Array.isArray(d.attachments) ? d.attachments : [] };
}

export function discordConnector(store: TextingStore, deps: DiscordDeps = {}): Connector {
  const env: DiscordEnv = store.env === process.env ? PROCESS_ENV : store.env;
  const saved = () => cleanSettings(store.section<DiscordSettings>(DISCORD));
  const envToken = () => env.TETHER_DISCORD_TOKEN?.trim() || undefined;
  const envOwners = () => ids(env.TETHER_DISCORD_OWNER_IDS).filter(isId);
  const envChannel = () => (isId(env.TETHER_DISCORD_CHANNEL_ID?.trim()) ? env.TETHER_DISCORD_CHANNEL_ID!.trim() : undefined);
  const token = () => envToken() ?? saved().token;
  const owners = () => (envOwners().length ? envOwners() : (saved().ownerIds ?? []));
  const channel = () => envChannel() ?? saved().channelId;
  for (const k of [saved().token, envToken()]) if (k) registerSecret(k);
  // The daily identify budget survives a restart: kept with these settings.
  keepIdentifies({ load: () => saved().identifies ?? [], save: (identifies) => store.setSection(DISCORD, { ...saved(), identifies }) });

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
      "Message your Discord bot in a DM (or in one server channel) the same as texting Tether: the Home agent, session numbers, y or n to a request. Only the user IDs set here can drive it; anyone else, and other bots, are ignored. Every ID listed is treated as you and sees everything (they're meant to be your own accounts). Tether writes to your DMs; in the channel it only answers what you wrote there.",
    notReady: "Set the bot token and your Discord user ID first, and turn Discord on.",
    enabled: () => saved().enabled ?? (!!envToken() && envOwners().length > 0),
    configured: () => !!config(),
    async open(onInbound, log) {
      const cfg = config();
      if (!cfg) throw new Error("not set up");
      const rest = new Rest(cfg.token, deps.fetch ?? fetch, deps.apiUrl);
      const fetcher = deps.fetch ?? fetch;
      /** An owner's DM channel: kept (with the last one, `where`), so an answer finds its owner's DM after a reconnect. */
      const rememberDm = (id: string, owner: string) => {
        const now = saved();
        if (now.dms?.[id] === owner && now.where?.id === id) return;
        const dms = Object.fromEntries([...Object.entries(now.dms ?? {}).filter(([k]) => k !== id), [id, owner]].slice(-20));
        store.setSection(DISCORD, { ...now, dms, where: { kind: "dm", id, owner } });
      };
      /** A DM that turned out gone (Discord answered 403/404): forgotten, so the next send opens a fresh one. */
      const forgetDm = (id: string) => {
        const now = saved();
        const dms = { ...(now.dms ?? {}) };
        delete dms[id];
        store.setSection(DISCORD, { ...now, dms, ...(now.where?.id === id ? { where: undefined } : {}) });
      };
      /** what the bot posted in the channel lately: a reply to one there is for Tether */
      const posted: string[] = [];
      const gateway = new Gateway(
        cfg.token,
        (type, d) => {
          if (type !== "MESSAGE_CREATE") return;
          const m = personMessage(d, { selfId: gateway.self?.id, ownerIds: cfg.ownerIds, channelId: cfg.channelId, mine: (id) => posted.includes(id) });
          if (!m) return;
          if (m.dm) {
            rememberDm(m.channelId, m.author);
          }
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
            place: m.channelId,
            ...(m.dm ? {} : { shared: true }),
            ...(m.replyTo ? { replyTo: m.replyTo } : {}),
            ...(files.length ? { files } : {}),
            react: (emoji) => rest.react(m.channelId, m.id, emoji),
          };
          onInbound(msg);
        },
        { log, ...deps.gateway },
      );
      await gateway.start();
      /** Opens (or finds) an owner's DM. */
      const opening = new Map<string, Promise<string>>();
      const openDm = async (owner: string) => {
        let p = opening.get(owner);
        if (!p) {
          p = rest.dm(owner).finally(() => opening.delete(owner));
          opening.set(owner, p);
        }
        const id = await p;
        rememberDm(id, owner);
        return id;
      };
      /**
       * Where Tether writes: the set channel only for the direct answer to a message written there
       * (`shared`); an answer to an owner's DM back to that DM; anything else to the DM the person
       * last wrote in, else the first owner's.
       */
      const target = async (place?: string, shared?: boolean): Promise<string> => {
        if (shared && place && place === cfg.channelId) return place;
        if (place && cfg.ownerIds.includes(saved().dms?.[place] ?? "")) return place;
        const w = saved().where;
        if (w && cfg.ownerIds.includes(w.owner)) return w.id;
        return openDm(cfg.ownerIds[0]!);
      };

      const link = {
        async send(out: { text: string; images?: string[]; files?: { name: string; mimeType: string; data: Uint8Array }[]; place?: string; shared?: boolean }) {
          const files = [
            // A path is read and checked like an agent's image (images.ts): never just any file.
            ...(out.images ?? []).map((p) => {
              const r = readOutgoingImage(p);
              if ("problem" in r) throw new Error(r.problem);
              return { name: r.name, data: new Uint8Array(r.data), type: r.mimeType };
            }),
            // Bytes already read and checked (an agent's text_person image): sent as they are.
            ...(out.files ?? []).map((f) => ({ name: f.name, data: f.data, type: f.mimeType })),
          ];
          const parts = splitMessage(unmask(out.text));
          if (!parts.length && !files.length) return [];
          if (!parts.length) parts.push("");
          let to = await target(out.place, out.shared);
          const sent: string[] = [];
          let reopened = false;
          try {
            for (const [i, part] of parts.entries()) {
              let id: string | undefined;
              try {
                id = await rest.post(to, part, i === parts.length - 1 ? files : []);
              } catch (e: any) {
                if (reopened) throw e;
                reopened = true;
                if (to === cfg.channelId) {
                  // The channel didn't take it (no access, deleted, …): the owner's DM instead.
                  to = await target();
                } else {
                  // A saved DM Discord no longer takes: open the owner's DM again, once.
                  const owner = saved().dms?.[to] ?? (saved().where?.id === to ? saved().where!.owner : undefined);
                  if (e?.status !== 403 && e?.status !== 404) throw e;
                  forgetDm(to);
                  to = await openDm(owner && cfg.ownerIds.includes(owner) ? owner : cfg.ownerIds[0]!);
                }
                id = await rest.post(to, part, i === parts.length - 1 ? files : []);
              }
              if (id) sent.push(id);
            }
          } catch (e: any) {
            if (sent.length) throw new PartialSend(String(e?.message ?? e), sent);
            throw e;
          }
          if (to === cfg.channelId) {
            posted.push(...sent);
            posted.splice(0, Math.max(0, posted.length - 200));
          }
          return sent;
        },
        up: () => gateway.up,
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
          note: "In the channel, start with @ and the bot's name (the bot user, not its role), or reply to one of its messages. It answers there only what you wrote there, and anyone who can see the channel can read it.",
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
        // Another bot: its DMs are other channels.
        if ((t || undefined) !== next.token) {
          delete next.where;
          delete next.dms;
        }
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
