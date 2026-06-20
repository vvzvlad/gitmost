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
 * Derive a DETERMINISTIC unique footnote id for the k-th (k >= 2) occurrence of
 * an original id `X` during collision resolution. The result is a pure function
 * of (`originalId`, `occurrence`, `taken`) so that every collaborating client —
 * and every import path — computes the SAME new id for the same input document.
 *
 * CRITICAL: this MUST NOT use Math.random()/Date.now()/uuid. Two clients that
 * each make a local edit on the same duplicate-id document have to converge on
 * identical ids; a random id would diverge permanently over Yjs.
 *
 * Scheme: the base candidate is `${originalId}__${occurrence}` (e.g. `X__2`,
 * `X__3`). If that candidate already exists in `taken` (an existing footnote id,
 * or one we already minted in this pass), a stable alphabetic suffix is appended
 * and bumped — `X__2b`, `X__2c`, ... — until the candidate is unique. `taken` is
 * itself part of the document state, so the whole walk stays deterministic.
 *
 * `taken` is consulted but NOT mutated here; the caller adds the returned id to
 * its own seen-set before requesting the next derived id.
 *
 * NOTE: this implementation is intentionally duplicated in
 *   packages/mcp/src/lib/collaboration.ts (deriveFootnoteId)
 * and MUST stay in sync with it so markdown imported through either path yields
 * identical ids.
 */
export function deriveFootnoteId(
  originalId: string,
  occurrence: number,
  taken: Set<string> | ReadonlySet<string>,
): string {
  let candidate = `${originalId}__${occurrence}`;
  // Deterministic suffix bump: b, c, d, ... then aa, ab, ... if ever exhausted.
  let n = 0;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${originalId}__${occurrence}${suffix(n)}`;
  }
  return candidate;
}

/**
 * Map 1 -> "b", 2 -> "c", ... 25 -> "z", 26 -> "ba", ... (base-25 over b..z,
 * skipping "a" so the first bump is visibly distinct from the un-bumped base).
 * Purely deterministic.
 */
function suffix(n: number): string {
  let out = "";
  let x = n;
  while (x > 0) {
    const rem = (x - 1) % 25;
    out = String.fromCharCode(98 + rem) + out; // 98 = 'b'
    x = Math.floor((x - 1) / 25);
  }
  return out;
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
