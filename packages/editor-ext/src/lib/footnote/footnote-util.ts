import { Node as ProseMirrorNode } from "@tiptap/pm/model";

/**
 * Node type names for the footnote feature. Centralized so every part of the
 * feature (nodes, plugins, commands) references the same string.
 */
export const FOOTNOTE_REFERENCE_NAME = "footnoteReference";
export const FOOTNOTES_LIST_NAME = "footnotesList";
export const FOOTNOTE_DEFINITION_NAME = "footnoteDefinition";

/**
 * Generate a uuidv7-style id (time-ordered). Implemented locally so editor-ext
 * does not need a runtime dependency on the `uuid` package; matches the
 * lexicographically-sortable layout uuidv7 produces.
 */
export function generateFootnoteId(): string {
  const now = Date.now();
  const timeHex = now.toString(16).padStart(12, "0");

  const rand = (length: number) => {
    let out = "";
    for (let i = 0; i < length; i++) {
      out += Math.floor(Math.random() * 16).toString(16);
    }
    return out;
  };

  // version 7 nibble, then variant (8..b) nibble.
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

/**
 * Collect every `footnoteReference` id in document order. This is the single
 * source of truth for numbering and ordering — a pure function of the document
 * so every collaborating client computes the same result.
 */
export function collectReferenceIds(doc: ProseMirrorNode): string[] {
  const ids: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === FOOTNOTE_REFERENCE_NAME) {
      const id = node.attrs.id;
      if (id) ids.push(id);
    }
  });
  return ids;
}

/**
 * Build a map of `referenceId -> displayNumber` (1-based) from document order.
 * Pure function — the basis for the numbering decorations and any test.
 */
export function computeFootnoteNumbers(
  doc: ProseMirrorNode,
): Map<string, number> {
  const numbers = new Map<string, number>();
  let n = 0;
  for (const id of collectReferenceIds(doc)) {
    if (!numbers.has(id)) {
      numbers.set(id, ++n);
    }
  }
  return numbers;
}
