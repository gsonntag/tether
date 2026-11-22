// The line between texting and the agents (SPEC §11 Texting): any agent Tether runs texts the
// person with its text_person tool (peers module), and texting sends it. Each module plugs its own
// end in when it starts; neither imports the other. Not an op: browsers have no business sending
// texts as Tether.

import type { Attachment } from "../../../shared/attachments";

/** How long an agent's own text (text_person) may be. */
export const PERSON_TEXT_MAX = 300;
/** What text_person answers a session whose "Session can text me" box is off (texting/index.ts canText). */
export const CANT_TEXT = "This session isn't allowed to text the person (the 'Session can text me' box is off). Put it in your reply instead.";

/** A file as bytes (an image an agent texts, read and checked: texting/images.ts). */
export interface TextedFile {
  name: string;
  mimeType: string;
  data: Buffer;
}

/** Said to an agent with a HEIC photo that couldn't be made a JPEG (texting/images.ts): it's attached by its path only. */
export const HEIC_NOTE = "(The photo is HEIC and couldn't be converted, so it's attached by its path only.)";

/** The line a message carries after its words when one of its attachments is a HEIC photo, else "". */
export const heicNote = (list: Attachment[]) => (list.some((a) => /^image\/hei[cf]$/.test(a.mimeType)) ? `\n\n${HEIC_NOTE}` : "");

/** Texting's end. */
export interface PhoneEnd {
  /**
   * An agent's text_person: texts the person for session `from`, and their reply comes back to it.
   * `image`: a path to an image file sent after the words (texting/images.ts checks it). What the
   * tool answers the agent.
   */
  text(from: string, body: string, o?: { image?: string }): Promise<{ text: string; isError?: boolean }>;
}

export class PhoneLine {
  phone?: PhoneEnd;
}
