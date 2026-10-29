// Messages Tether sends to a harness on the person's behalf (an answer passed on after a runner
// restart, SPEC §7) start with this marker. The harness stores them as user turns; readers (live
// and stored alike) recognize the marker and show them as Tether's, not as something you typed.

export const FROM_TETHER = "[From Tether] ";

/** The text without the marker when it is one of Tether's messages, else undefined. */
export const fromTether = (text: string): string | undefined => (text.startsWith(FROM_TETHER) ? text.slice(FROM_TETHER.length) : undefined);
