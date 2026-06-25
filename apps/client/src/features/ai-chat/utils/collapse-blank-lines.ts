// Pure helper for compact reasoning ("Thinking") rendering. Kept free of React
// so it can be unit-tested in isolation (see collapse-blank-lines.test.ts).

/**
 * Collapse runs of 2+ newlines down to a single newline, EXCEPT inside fenced
 * code blocks (``` ... ``` or ~~~ ... ~~~), where blank lines are significant.
 *
 * Why: reasoning models emit thinking with a blank line (`\n\n`) between every
 * list item and paragraph. `marked` turns those into "loose" lists (each `<li>`
 * wrapped in a `<p>`) and separate `<p>` paragraphs, each carrying a vertical
 * margin — so the "Thinking" block renders with large, airy gaps. Removing the
 * blank-line gaps yields tight lists (no `<li><p>`) and joined paragraphs. The
 * chat markdown renderer runs with `breaks: true`, so a single `\n` still
 * becomes a `<br>` — line breaks inside the reasoning are preserved; only the
 * empty gaps between blocks disappear. Apply ONLY to reasoning text, never to a
 * normal assistant answer (where paragraph spacing is intentional).
 *
 * Fenced code is preserved verbatim: a fence opens on a line whose first
 * non-space characters are ``` or ~~~ and closes on the next line that starts
 * with the same fence character. Blank lines between fences (significant for
 * code formatting) are never collapsed.
 */
export function collapseBlankLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceChar = "";

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const ch = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
      } else if (ch === fenceChar) {
        inFence = false;
      }
      out.push(line);
      continue;
    }

    // Inside a fenced block every line (including blanks) is significant.
    if (inFence) {
      out.push(line);
      continue;
    }

    // Outside fences: drop blank lines so a `\n\n+` gap collapses to a single
    // `\n` between the surrounding content lines.
    if (line.trim() === "") continue;
    out.push(line);
  }

  return out.join("\n");
}
