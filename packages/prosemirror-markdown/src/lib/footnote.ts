/**
 * #293 canon #2: inline footnotes `^[text]`.
 *
 * Shared, side-effect-free helpers used by BOTH the serializer
 * (markdown-converter.ts) and the importer (markdown-to-prosemirror.ts) so the
 * two directions cannot drift.
 *
 * The canonical markdown form is Pandoc/Obsidian inline footnotes: the note body
 * is written AT the reference point as `^[body]`; there is no separate
 * `[^id]: …` definition line and no bottom `<section>` list in the markdown. On
 * import the body is re-assembled into the schema's doc-level
 * `footnotesList`/`footnoteDefinition` so the editor sees the usual three-node
 * footnote model, while identical bodies MERGE to a single definition shared by
 * every reference. Ids are assigned by the importer's assembleFootnotes pass
 * (dedup on the EXACT body text -> sequential `fn-N`), NOT derived from a hash,
 * so two DIFFERENT bodies can never collide onto one definition (F1). The id is
 * never written to markdown (`^[body]` carries only text), so the round trip
 * stays byte-stable regardless of the concrete id.
 */

/**
 * Split an ENCODED footnote body (the inner captured between `^[` and its
 * matching `]`, or the value of a `data-fn-text` attribute) into its paragraph
 * markdown strings.
 *
 * Paragraph boundaries are the two-character literal separator `\n` (backslash +
 * n); a REAL backslash-n in the body was encoded as `\\n` (an escaped backslash
 * followed by n) by the serializer, so it must NOT split. The scan therefore
 * treats any `\<char>` as an escaped pair kept verbatim (so `\\` `n` stays a
 * literal backslash-then-n and the trailing `n` is plain), and only an
 * UNescaped `\n` is a separator. Every other backslash escape (`\=`, `\$`,
 * `\[`, …) is preserved untouched so the per-paragraph `parseInline` decodes it.
 */
export function splitFootnoteParagraphs(encoded: string): string[] {
  const paragraphs: string[] = [];
  let current = "";
  let i = 0;
  while (i < encoded.length) {
    const c = encoded[i];
    if (c === "\\" && i + 1 < encoded.length) {
      const next = encoded[i + 1];
      if (next === "n") {
        // Unescaped backslash-n: a paragraph separator.
        paragraphs.push(current);
        current = "";
        i += 2;
        continue;
      }
      // Any other escaped pair (including `\\`) is kept verbatim; consuming
      // BOTH chars is what makes an encoded real `\n` (`\\n`) safe — the `\\`
      // pair is taken here, leaving the following `n` as an ordinary literal.
      current += c + next;
      i += 2;
      continue;
    }
    current += c;
    i++;
  }
  paragraphs.push(current);
  return paragraphs;
}

// ---------------------------------------------------------------------------
// Inline-authoring helpers (#414: moved here from the mcp `footnote-authoring.ts`
// fork so the dedup convention — content-key + definition factory + id gen —
// has ONE home next to the importer that shares the convention). Used by the
// mcp author-inline tool (`insertInlineFootnote` in transforms.ts).
// ---------------------------------------------------------------------------

const FOOTNOTE_DEFINITION_NAME = "footnoteDefinition";

function cloneJson<T>(v: T): T {
  if (typeof structuredClone === "function") return structuredClone(v);
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Normalized content key for de-duplicating footnote DEFINITIONS by their text.
 *
 * Two definitions with the same key are the SAME footnote — so the inline
 * authoring tool reuses one id (one number, one definition, several references)
 * instead of minting a second definition. Key = plaintext (whitespace-collapsed,
 * trimmed) PLUS a signature of the inline mark types in order, so two notes that
 * read the same but differ in formatting (one bold, one plain) are NOT merged.
 * Conservative: only an exact match merges.
 */
export function footnoteContentKey(defNode: any): string {
  const parts: string[] = [];
  const visit = (n: any): void => {
    if (!n || typeof n !== "object") return;
    if (n.type === "text" && typeof n.text === "string") {
      const marks = Array.isArray(n.marks)
        ? n.marks.map((m: any) => m?.type).filter(Boolean).sort().join(",")
        : "";
      parts.push(`${n.text}${marks}`);
    }
    if (Array.isArray(n.content)) for (const c of n.content) visit(c);
  };
  visit(defNode);
  // Collapse the assembled text's whitespace and trim, keeping the mark
  // signature attached so formatting differences still distinguish notes.
  return parts
    .join("")
    .replace(/[ \t\r\n]+/g, " ")
    .trim();
}

/**
 * Build a footnoteDefinition node from inline ProseMirror nodes, keyed by id.
 */
export function makeFootnoteDefinition(id: string, inlineNodes: any[]): any {
  const content = Array.isArray(inlineNodes) ? cloneJson(inlineNodes) : [];
  return {
    type: FOOTNOTE_DEFINITION_NAME,
    attrs: { id },
    content: [{ type: "paragraph", content }],
  };
}

/**
 * Generate a uuidv7-style id (time-ordered), matching editor-ext's
 * `generateFootnoteId`. Used for a genuinely-new inline footnote id.
 */
export function generateFootnoteId(): string {
  const now = Date.now();
  const timeHex = now.toString(16).padStart(12, "0");
  const rand = (length: number) => {
    let s = "";
    for (let i = 0; i < length; i++)
      s += Math.floor(Math.random() * 16).toString(16);
    return s;
  };
  const versioned = "7" + rand(3);
  const variantNibble = (8 + Math.floor(Math.random() * 4)).toString(16);
  const variant = variantNibble + rand(3);
  return (
    timeHex.slice(0, 8) +
    "-" +
    timeHex.slice(8, 12) +
    "-" +
    versioned +
    "-" +
    variant +
    "-" +
    rand(12)
  );
}
