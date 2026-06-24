import { marked } from "marked";

/**
 * Pandoc/GFM footnote support for the marked (Markdown -> HTML) pipeline.
 *
 * Two pieces:
 *  - an INLINE tokenizer for `[^id]` references -> <sup data-footnote-ref
 *    data-id="id"> (matches the editor-ext FootnoteReference renderHTML);
 *  - a document hook (`preprocess`/`walkTokens` is awkward for collecting +
 *    removing definitions, so we use a regex preprocessing step instead) that
 *    pulls every `[^id]: text` definition line out of the body and appends a
 *    single <section data-footnotes> with one <div data-footnote-def> per
 *    definition, so the round-trip rebuilds footnotesList + footnoteDefinition.
 *
 * Every FIRST definition line is emitted — duplicate ids are first-wins (the
 * rest are dropped, and surfaced via analyzeFootnotes), and reference markers are
 * left untouched so repeated `[^a]` references reuse the one footnote (#166).
 * Orphan definitions (no matching reference) are still emitted here; the editor's
 * sync plugin reconciles the final reference/definition set (drops orphans,
 * synthesizes a single empty definition for a reference that lacks one).
 */

const DEFINITION_RE = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/;
const REFERENCE_RE = /\[\^([^\]\s]+)\]/;

interface FootnoteRefToken {
  type: "footnoteRef";
  raw: string;
  id: string;
}

export const footnoteReferenceExtension = {
  name: "footnoteRef",
  level: "inline" as const,
  start(src: string) {
    return src.match(/\[\^/)?.index ?? -1;
  },
  tokenizer(src: string): FootnoteRefToken | undefined {
    const match = REFERENCE_RE.exec(src);
    // Only match at the very start of the remaining inline source.
    if (match && match.index === 0) {
      return {
        type: "footnoteRef",
        raw: match[0],
        id: match[1],
      };
    }
    return undefined;
  },
  renderer(token: FootnoteRefToken) {
    return `<sup data-footnote-ref data-id="${escapeAttr(token.id)}"></sup>`;
  },
};

function escapeAttr(value: string): string {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Extract `[^id]: text` definition lines from the markdown body, returning the
 * cleaned body plus a rendered <section data-footnotes> (empty string when no
 * definitions). Call this BEFORE marked.parse and append the section to the
 * resulting HTML.
 */
export function extractFootnoteDefinitions(markdown: string): {
  body: string;
  section: string;
} {
  const lines = markdown.split("\n");
  const bodyLines: string[] = [];
  const definitions: Array<{ id: string; text: string }> = [];

  // Track fenced-code state so a `[^id]: ...` line that merely SHOWS footnote
  // syntax inside a ``` / ~~~ code block is left in the body verbatim and not
  // mistaken for a real definition.
  let fence: string | null = null;

  for (const line of lines) {
    const fenceMatch = /^(\s*)(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[2][0];
      if (fence === null) {
        fence = marker; // opening fence
      } else if (marker === fence) {
        fence = null; // closing fence (matching delimiter type)
      }
      bodyLines.push(line);
      continue;
    }

    const m = fence === null ? DEFINITION_RE.exec(line) : null;
    if (m) {
      definitions.push({ id: m[1], text: m[2] });
    } else {
      bodyLines.push(line);
    }
  }

  if (definitions.length === 0) {
    return { body: markdown, section: "" };
  }

  // Duplicate definition ids (e.g. `[^d]: first` / `[^d]: second`): FIRST WINS,
  // the rest are DROPPED. Reference markers are left UNTOUCHED so repeated `[^a]`
  // references reuse the single footnote (Pandoc semantics, #166). This differs
  // from the live editor's never-lose policy (resolveCollisions re-ids a
  // duplicate definition into an orphan) on purpose: an import is an
  // agent-authored artifact we sanitize, and the dropped duplicate is surfaced
  // to the caller via analyzeFootnotes' `duplicateDefinitions` warning instead.
  const firstById = new Map<string, string>(); // id -> first definition text
  for (const def of definitions) {
    if (!firstById.has(def.id)) firstById.set(def.id, def.text);
  }

  const defsHtml = [...firstById.entries()]
    .map(([id, text]) => {
      // Render the definition text as inline markdown so emphasis/links inside
      // a footnote survive the round-trip; wrap in a paragraph (the node's
      // content is paragraph+).
      const inner = marked.parseInline(text || "");
      return `<div data-footnote-def data-id="${escapeAttr(
        id,
      )}"><p>${inner}</p></div>`;
    })
    .join("");

  return {
    body: bodyLines.join("\n"),
    section: `<section data-footnotes>${defsHtml}</section>`,
  };
}
