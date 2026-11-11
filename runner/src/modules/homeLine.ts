// The line between texting and the Home agent (SPEC §11 Texting, "Texting the Home agent"): the
// person texts the Home agent, and its short replies go back by text. Each module plugs its own end
// in when it starts; neither imports the other. Not an op: browsers have no business sending texts
// as Tether or posing as the person's phone.

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
}

export class HomeLine {
  home?: HomeEnd;
  phone?: PhoneEnd;
}
