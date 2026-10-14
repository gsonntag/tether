// Labels for the Commands and Subagents sections (components/Library.tsx).

/** "Added by you", or "From Claude Code, Codex" for the harnesses its files came from. */
export function fromLabel(sources: string[], label: (source: string) => string): string {
  if (sources.includes("you")) return "Added by you";
  const names = [...new Set(sources.map(label))];
  return names.length ? `From ${names.join(", ")}` : "";
}

/** The `/` menu's badge for one of your commands: whether this harness runs it or Tether fills it in. */
export const commandRunsHow = (native: boolean | undefined) =>
  native ? "This harness has the command and runs it itself" : "This harness doesn't have the command, so Tether fills in the arguments and sends the text";
