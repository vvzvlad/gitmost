import { marked } from "marked";
import { deriveFootnoteId } from "../../footnote/footnote-util";

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
 * Only definitions that have a matching reference are emitted (and vice-versa
 * the sync plugin fills any gaps on the editor side), keeping the output valid.
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  // De-duplicate colliding definition ids. Two definitions sharing an id (e.g.
  // `[^d]: first` / `[^d]: second`) would otherwise collapse into one footnote
  // downstream (the editor's last-wins sync). Rename each colliding id to a
  // DETERMINISTIC derived one AND rewrite the corresponding `[^id]` reference
  // marker so the (reference, definition) pairing stays 1:1. The FIRST
  // definition keeps the id and pairs with the FIRST `[^id]` marker; the Nth
  // duplicate gets the derived id `${id}__${N}` and rewrites the Nth `[^id]`
  // marker. If there are fewer markers than definitions, the surplus definition
  // keeps a derived (orphan) id so it is never silently merged away.
  //
  // The id is derived (deriveFootnoteId), NOT random: importing the same
  // markdown through two paths (here and the MCP mirror) must yield identical
  // ids, and re-importing the same markdown twice must be stable.
  let dedupedBody = bodyLines.join("\n");
  // Every original definition id is reserved up front so a derived id can never
  // collide with an unrelated original id present in the document.
  const taken = new Set<string>(definitions.map((d) => d.id));
  const seenDefIds = new Map<string, number>(); // original id -> how many seen
  for (const def of definitions) {
    const originalId = def.id;
    const count = seenDefIds.get(originalId) ?? 0;
    seenDefIds.set(originalId, count + 1);
    if (count === 0) continue; // first definition keeps its id

    // count is the 0-based number of PRIOR occurrences; this is occurrence
    // (count + 1), i.e. 2 for the first duplicate, 3 for the next, ...
    const newId = deriveFootnoteId(originalId, count + 1, taken);
    taken.add(newId);
    def.id = newId;

    // Rewrite the NEXT still-unrewritten `[^originalId]` marker that does not
    // belong to the keeper definition. After a prior duplicate rewrote its
    // marker (to `[^someNewId]`), it no longer matches `[^originalId]`, so the
    // remaining matches are: index 0 = the keeper's marker (left alone), index 1
    // = this duplicate's marker. Rewrite index 1.
    let occurrence = 0;
    let rewritten = false;
    const re = new RegExp(`\\[\\^${escapeRegExp(originalId)}\\]`, "g");
    dedupedBody = dedupedBody.replace(re, (match) => {
      const idx = occurrence++;
      if (!rewritten && idx === 1) {
        rewritten = true;
        return `[^${newId}]`;
      }
      return match;
    });
    // If there was no second marker (more definitions than references), the
    // duplicate simply survives as an orphan with its fresh id — no body change.
  }

  const defsHtml = definitions
    .map((d) => {
      // Render the definition text as inline markdown so emphasis/links inside
      // a footnote survive the round-trip; wrap in a paragraph (the node's
      // content is paragraph+).
      const inner = marked.parseInline(d.text || "");
      return `<div data-footnote-def data-id="${escapeAttr(
        d.id,
      )}"><p>${inner}</p></div>`;
    })
    .join("");

  return {
    body: dedupedBody,
    section: `<section data-footnotes>${defsHtml}</section>`,
  };
}
