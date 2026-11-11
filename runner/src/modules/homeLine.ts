// The line between texting and the agents (SPEC §11 Texting, "Texting the Home agent"): the
// person texts the Home agent, and its short replies go back by text; any agent Tether runs texts
// the person with its text_person tool (peers module, Home agent). Each module plugs its own end
// in when it starts; neither imports the other. Not an op: browsers have no business sending texts
// as Tether or posing as the person's phone.

/** Who the Home agent is when it texts (PhoneEnd.text), and what a Home text is noted under (texting/router.ts). */
export const HOME_SENDER = "home";
/** How long an agent's own text (text_person) may be. */
export const PERSON_TEXT_MAX = 300;

/** The Home agent's end. */
export interface HomeEnd {
  /** the person's text, to the Home agent's Texts chat (after its turn, if one runs) */
  take(text: string): Promise<void>;
  /** whether a session is the chat texts go to: its own turns aren't texted as a session's */
  isTextsChat(sessionId: string): boolean;
}

/** Texting's end. */
export interface PhoneEnd {
  /** texts the person as the Home agent ("[home] ok, on it"); false when it didn't go (texting off, not connected) */
  send(text: string): Promise<boolean>;
  /**
   * An agent's text_person: texts the person for session `from` (or the Home agent, texting/router.ts
   * HOME), and their reply comes back to it. What the tool answers the agent.
   */
  text(from: string, body: string): Promise<{ text: string; isError?: boolean }>;
}

export class HomeLine {
  home?: HomeEnd;
  phone?: PhoneEnd;
}
