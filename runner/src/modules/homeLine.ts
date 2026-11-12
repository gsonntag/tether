// The line between texting and the agents (SPEC §11 Texting, "Texting the Home agent"): the
// person texts the Home agent, and its short replies go back by text; any agent Tether runs texts
// the person with its text_person tool (peers module, Home agent). Each module plugs its own end
// in when it starts; neither imports the other. Not an op: browsers have no business sending texts
// as Tether or posing as the person's phone.
//
// The Home agent has several chats (Home's tabs), each one a "home" the person can text by its
// label: `h` is the primary one (the Texts tab), `h1`, `h2`, … the others (homeAgent/index.ts gives
// each tab its number, kept while it's open).

import type { Attachment } from "../../../shared/attachments";

/** Who the Home agent is when it texts (PhoneEnd.text), and what a Home text is noted under (texting/router.ts). */
export const HOME_SENDER = "home";
/** How long an agent's own text (text_person) may be. */
export const PERSON_TEXT_MAX = 300;

/** At most this many homes besides the primary one (h1 … h9). */
export const MAX_EXTRA_HOMES = 9;

/** A home's label as the person texts it and sees it: "h" for the primary one (0), "h1", "h2", … */
export const homeLabel = (n: number) => (n === 0 ? "h" : `h${n}`);

/** The open homes as a short list for a text: "h, h1, h3". */
export const homeList = (homes: { n: number }[]) => [...homes].sort((a, b) => a.n - b.n).map((h) => homeLabel(h.n)).join(", ");

/** A file as bytes (an image an agent texts, read and checked: texting/images.ts). */
export interface TextedFile {
  name: string;
  mimeType: string;
  data: Buffer;
}

/** What one of the Home agent's texts was about: a session. */
export interface TextAbout {
  sessionId: string;
  title?: string;
  project?: string;
}

const oneLine = (s: string, max: number) => s.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029()"[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
/** A session id as it may appear in the line: id characters only. */
const cleanId = (id: string) => id.replace(/[^\w:.@-]+/g, "").slice(0, 200);

/**
 * The line before a text the person sent right after one of the Home agent's texts about a session:
 * it reads the reply as being about that session ("(replying to your text about session
 * claude:abc, "login fix" in /home/me/web) merge it").
 */
export function replyContext(a: TextAbout): string {
  const title = a.title ? oneLine(a.title, 120) : "";
  const project = a.project ? oneLine(a.project, 200) : "";
  return `(replying to your text about session ${cleanId(a.sessionId)}${title ? `, "${title}"` : ""}${project ? ` in ${project}` : ""}) `;
}

/** Said to an agent with a HEIC photo that couldn't be made a JPEG (texting/images.ts): it's attached by its path only. */
export const HEIC_NOTE = "(The photo is HEIC and couldn't be converted, so it's attached by its path only.)";

/** The line a message carries after its words when one of its attachments is a HEIC photo, else "". */
export const heicNote = (list: Attachment[]) => (list.some((a) => /^image\/hei[cf]$/.test(a.mimeType)) ? `\n\n${HEIC_NOTE}` : "");

/** One of the Home agent's homes: its number (0: the primary one) and its chat, once there is one. */
export interface Home {
  n: number;
  chat?: string;
}

/** Which home a text goes to: by number (a prefix), or by chat (a reply to that chat's text). */
export type HomeTarget = { n: number } | { chat: string };

/** How the person's text reached Tether (texting/connector.ts). */
export interface TakeVia {
  /** what marks it as theirs, by its connector ("[From iMessage] ", shared/fromTether.ts); iMessage's when unset */
  mark?: string;
  /** the files that came with it, stored for the chat that takes them */
  files?: (sessionId: string) => Promise<Attachment[]>;
}

/** The Home agent's end. */
export interface HomeEnd {
  /**
   * The person's text to a home (none: the primary one, made if it's gone), after its turn if one
   * runs, marked with the connector it came by, with the files they sent. Throws when that home
   * isn't open.
   */
  take(text: string, via?: TakeVia, to?: HomeTarget): Promise<void>;
  /** the open homes, the primary one (n 0) always among them (its chat absent until it's made) */
  homes(): Home[];
  /** a new home (a new Home tab): its number; `text` (and `via`'s files), if any, is its first message */
  newHome(text: string, via?: TakeVia): Promise<number>;
  /** deletes home `n` (its chat is archived, as closing its tab does): the homes left. Throws for the primary one or one that isn't open */
  deleteHome(n: number): Promise<Home[]>;
  /** whether a session is a chat texts go to: its own turns aren't texted as a session's */
  isTextsChat(sessionId: string): boolean;
  /** a home's chat (none: the primary one, the Texts chat) is running a turn or has messages waiting (a text now wouldn't start its next turn) */
  textsBusy?(chat?: string): boolean;
  /** the chat a text to this home goes to (h's made if it's gone); throws when that home isn't open */
  chatOf?(to?: HomeTarget): Promise<string>;
  /**
   * A session's text_person, when the Home agent drives that session (started or messaged it, and
   * the person hasn't stepped in): the message goes to the Home agent as a report instead, and it
   * decides what to text (it's the person's PM). What the tool answers the session; undefined: the
   * Home agent doesn't drive it, so it texts the person itself.
   */
  relay?(sessionId: string, message: string, image?: string): Promise<string | undefined>;
}

/** Texting's end. */
export interface PhoneEnd {
  /**
   * Texts the person as one of the Home agent's chats ("[home] ok, on it"; "[h1] …" from home 1);
   * false when it didn't go (texting off, not connected). `answer`: it's the direct answer to a text
   * they sent, so it may go back to where they wrote it (a server channel); anything else goes to
   * them privately. `about`: the session the text is about, so a reply right after it is read as
   * about that session too. `chat`: the chat that texts (none: the primary home).
   */
  send(text: string, o?: { answer?: boolean; about?: string; chat?: string }): Promise<boolean>;
  /**
   * An agent's text_person: texts the person for session `from` (or the Home agent, texting/router.ts
   * HOME, as `chat`), and their reply comes back to it. `image`: a path to an image file sent after
   * the words (texting/images.ts checks it). `about`: for the Home agent, the session it's about.
   * What the tool answers the agent.
   */
  text(from: string, body: string, o?: { image?: string; about?: string; chat?: string }): Promise<{ text: string; isError?: boolean }>;
  /** a Home chat went on in another (a move, homeAgent moved()): replies to its texts go to `to` now */
  moved?(from: string, to: string): void;
}

export class HomeLine {
  home?: HomeEnd;
  phone?: PhoneEnd;
}
