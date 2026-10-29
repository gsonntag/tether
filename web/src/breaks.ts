// Single newlines in a reply are line breaks, as the CLI shows them (markdown would join them
// into one line: "1\n2\n3" as "1 2 3"). Outside code fences, a line that continues on the next
// line gets markdown's hard break (two trailing spaces).

export function hardBreaks(text: string): string {
  let fence: string | null = null;
  const lines = text.split("\n");
  return lines
    .map((line, i) => {
      const m = line.match(/^\s*(`{3,}|~{3,})/);
      if (m) {
        if (!fence) fence = m[1]![0]!;
        else if (m[1]![0] === fence) fence = null;
        return line;
      }
      const next = lines[i + 1];
      if (fence || next === undefined || !line.trim() || !next.trim() || /^\s*(`{3,}|~{3,})/.test(next)) return line;
      return line.endsWith("  ") ? line : `${line}  `;
    })
    .join("\n");
}
