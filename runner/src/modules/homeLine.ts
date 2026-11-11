// The line between texting and the agents (SPEC §11 Texting, "Texting the Home agent"): the
// person texts the Home agent, and its short replies go back by text; any agent Tether runs texts
// the person with its text_person tool (peers module, Home agent). Each module plugs its own end
// in when it starts; neither imports the other. Not an op: browsers have no business sending texts
// as Tether or posing as the person's phone.

/** Who the Home agent is when it texts (PhoneEnd.text), and what a Home text is noted under (texting/router.ts). */
export const HOME_SENDER = "home";
/** How long an agent's own text (text_person) may be. */
export const PERSON_TEXT_MAX = 300;

/** A file the person texted (an image), as bytes: the runner stores it as the receiving session's attachment. */
export interface TextedFile {
  name: string;
  mimeType: string;
  data: Buffer;
}

/** What one of Tether's texts was about: a session, and whether the Home agent sent it. */
export interface TextAbout {
  sessionId: string;
  /** the Home agent's own text (else a session's, or Tether's request text) */
  byHome?: boolean;
  title?: string;
  project?: string;
}

const oneLine = (s: string, max: number) => s.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029()"]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * The line before a text the person sent right after one of Tether's texts about a session: the
 * Home agent reads the reply as being about that session ("(replying to your text about session
 * claude:abc, "login fix" in /home/me/web) merge it").
 */
export function replyContext(a: TextAbout): string {
  const title = a.title ? oneLine(a.title, 120) : "";
  const project = a.project ? oneLine(a.project, 200) : "";
  return `(replying to ${a.byHome ? "your" : "Tether's"} text about session ${a.sessionId}${title ? `, "${title}"` : ""}${project ? ` in ${project}` : ""}) `;
}

const REPLY_CONTEXT = /^\(replying to (?:your|Tether's) text about session ([^\s,()]+)[,)]/;

/** The session a texted message's context line (replyContext) names, if it has one. */
export function aboutOf(text: string): string | undefined {
  return REPLY_CONTEXT.exec(text)?.[1];
}

/** The Home agent's end. */
export interface HomeEnd {
  /** the person's text, to the Home agent's Texts chat (after its turn, if one runs), with the images they texted */
  take(text: string, files?: TextedFile[]): Promise<void>;
  /** whether a session is the chat texts go to: its own turns aren't texted as a session's */
  isTextsChat(sessionId: string): boolean;
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
   * Texts the person as the Home agent ("[home] ok, on it"); false when it didn't go (texting off,
   * not connected). `about`: the session the text is about, so a reply right after it is read as
   * about that session too.
   */
  send(text: string, about?: string): Promise<boolean>;
  /**
   * An agent's text_person: texts the person for session `from` (or the Home agent, texting/router.ts
   * HOME), and their reply comes back to it. `image`: a path to an image file sent after the words
   * (texting/images.ts checks it). `about`: for the Home agent, the session it's about. What the tool
   * answers the agent.
   */
  text(from: string, body: string, o?: { image?: string; about?: string }): Promise<{ text: string; isError?: boolean }>;
}

export class HomeLine {
  home?: HomeEnd;
  phone?: PhoneEnd;
}
