/**
 * Deterministic server-side NORMALIZATION + MERGE of footnote DEFINITIONS
 * (MCP, PURE).
 *
 * Problem (#419): footnotes with the same meaning but different GLYPHS —
 * typographic quotes («…»/“…”) vs ASCII "…", em/en-dash vs `-`, non-breaking
 * space vs normal space, differing space counts — are not recognized as equal
 * and "fork": two definitions appear where the author meant one. The existing
 * de-dup paths miss this: `footnoteContentKey` (@docmost/prosemirror-markdown) only
 * collapses ASCII whitespace (quotes/dashes/NBSP untouched), and
 * `canonicalizeFootnotes` keys purely by `attrs.id` (the two forks have
 * different ids), so neither glues the forks together.
 *
 * This pass fixes that DETERMINISTICALLY on the MCP write-paths (an LLM
 * instruction gives no glue guarantee). It:
 *   1. Normalizes the TEXT of every `footnoteDefinition`'s text nodes IN PLACE
 *      (typographic quotes -> ASCII "/', dashes -> `-`, NBSP & friends ->
 *      normal space, whitespace runs collapsed, whole-definition edges
 *      trimmed) — unconditionally, for ALL definitions, KEEPING their marks.
 *   2. Computes a MERGE KEY per definition (normalized text + an ATTRS-AWARE
 *      inline-mark signature, via the local `footnoteMergeKey`), so notes that
 *      read the same but differ in formatting (bold vs plain) OR in a mark
 *      attribute (a `link` with a different `href`, differing `code`/`highlight`
 *      attrs) are NOT merged. See `footnoteMergeKey` for why this diverges from
 *      the shared type-only `footnoteContentKey`.
 *   3. Maps every duplicate definition id to the FIRST (document-order)
 *      definition's id and re-hangs `footnoteReference` nodes onto it.
 *
 * Duplicate definitions keep their original ids but now have NO references, so
 * the canonicalizer that runs immediately after this pass removes them as
 * orphans and derives the single tail list + numbering. This pass therefore
 * MUST run BEFORE `canonicalizeFootnotes(doc)` at every write-path call-site
 * (see the enforcement rule in `footnote-canonicalize.ts`).
 *
 * Accepted tradeoff: the exact typographic glyphs of the SURVIVING footnote are
 * rewritten to ASCII, in exchange for a GUARANTEED merge. Scope is strictly
 * INSIDE `footnoteDefinition` — body text (normal paragraphs) is never touched.
 *
 * Pure: deep-clones its input, deterministic, idempotent (a re-run is a no-op —
 * text is already normalized and references already point at the canonical id,
 * so no spurious mutations / git-sync churn).
 */

import {
  DOUBLE_QUOTES,
  SINGLE_QUOTES,
  DASHES,
  isLegacySpace,
} from "@docmost/prosemirror-markdown";

const FOOTNOTE_DEFINITION_NAME = "footnoteDefinition";
const FOOTNOTE_REFERENCE_NAME = "footnoteReference";

function cloneJson<T>(v: T): T {
  if (typeof structuredClone === "function") return structuredClone(v);
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Map typographic quotes/dashes to ASCII and collapse every whitespace run
 * (including NBSP & friends) to a SINGLE normal space. Does NOT trim — the
 * whole-definition edge trim is applied separately so inter-node spacing across
 * a multi-text-node definition is preserved.
 */
function normalizeAndCollapse(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (isLegacySpace(ch)) {
      while (i < s.length && isLegacySpace(s[i])) i++;
      out += " ";
      continue;
    }
    let mapped = ch;
    if (DOUBLE_QUOTES.indexOf(ch) !== -1) mapped = '"';
    else if (SINGLE_QUOTES.indexOf(ch) !== -1) mapped = "'";
    else if (DASHES.indexOf(ch) !== -1) mapped = "-";
    out += mapped;
    i++;
  }
  return out;
}

/** Collect every text node inside `def`, in document order (deep). */
function collectTextNodes(node: any, out: any[]): void {
  if (!node || typeof node !== "object") return;
  if (node.type === "text" && typeof node.text === "string") out.push(node);
  if (Array.isArray(node.content)) {
    for (const child of node.content) collectTextNodes(child, out);
  }
}

/** Collect every `footnoteDefinition` node in document order (deep). */
function collectDefinitions(node: any, out: any[]): void {
  if (!node || typeof node !== "object") return;
  if (node.type === FOOTNOTE_DEFINITION_NAME) out.push(node);
  if (Array.isArray(node.content)) {
    for (const child of node.content) collectDefinitions(child, out);
  }
}

/**
 * Normalize the text of one definition's text nodes IN PLACE: map glyphs +
 * collapse whitespace on every node (marks untouched), then trim the leading
 * edge of the first text node and the trailing edge of the last so the
 * definition as a whole is trimmed WITHOUT dropping the spacing between two
 * adjacent text nodes. The edge trims are guarded so an all-whitespace edge
 * node is never emptied into a schema-invalid empty text node.
 */
function normalizeDefinitionText(def: any): void {
  const textNodes: any[] = [];
  collectTextNodes(def, textNodes);
  for (const t of textNodes) {
    // Skip text carrying a `code` mark: inline code is a verbatim literal, not
    // prose typography. Rewriting quotes/dashes/special-spaces there would
    // corrupt the literal's meaning (a string literal, an em-dash flag, i18n).
    // Leaving it untouched also makes it contribute its RAW text to
    // `footnoteMergeKey`, so two notes differing only by glyphs inside code
    // stay distinct (while prose glyph-forks still merge). See #419.
    if ((t.marks || []).some((m: any) => m?.type === "code")) continue;
    t.text = normalizeAndCollapse(t.text);
  }
  if (textNodes.length === 0) return;
  const hasCodeMark = (t: any): boolean =>
    (t.marks || []).some((m: any) => m?.type === "code");
  const first = textNodes[0];
  if (!hasCodeMark(first)) {
    const startTrimmed = first.text.replace(/^ +/, "");
    if (startTrimmed !== "") first.text = startTrimmed;
  }
  const last = textNodes[textNodes.length - 1];
  if (!hasCodeMark(last)) {
    const endTrimmed = last.text.replace(/ +$/, "");
    if (endTrimmed !== "") last.text = endTrimmed;
  }
}

/** Rewrite `footnoteReference` ids IN PLACE using `defIdToCanon` (deep). */
function rehangReferences(
  node: any,
  defIdToCanon: Map<string, string>,
): void {
  if (!node || typeof node !== "object") return;
  if (node.type === FOOTNOTE_REFERENCE_NAME) {
    const id = node?.attrs?.id;
    if (typeof id === "string") {
      const canon = defIdToCanon.get(id);
      if (canon && canon !== id) node.attrs.id = canon;
    }
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) rehangReferences(child, defIdToCanon);
  }
}

/**
 * Stable, order-independent serialization of a mark's `attrs`: sort keys so the
 * same attrs always yield the same string regardless of authoring order. Empty /
 * missing attrs -> "" (so an attr-less mark keys identically to a type-only mark
 * signature, preserving bold-vs-plain parity).
 */
function stableAttrs(attrs: any): string {
  if (!attrs || typeof attrs !== "object") return "";
  const sorted: Record<string, any> = {};
  for (const k of Object.keys(attrs).sort()) sorted[k] = attrs[k];
  return JSON.stringify(sorted);
}

/**
 * ATTRS-AWARE merge key for a footnote definition. Deliberately DIVERGES from
 * the shared `footnoteContentKey` (@docmost/prosemirror-markdown): that key's mark
 * signature is TYPE-ONLY (`m.type`), so two definitions with identical visible
 * text but marks differing only in ATTRIBUTES — most importantly a `link` with a
 * different `href` (footnotes are usually citations/links), also `code` /
 * `highlight` with differing attrs — collapse to the SAME key and get merged;
 * one definition then loses its references and the canonicalizer deletes it as an
 * orphan, silently dropping a distinct link target (data loss, #419).
 *
 * This key folds each mark's `attrs` (stable, sorted-key serialization) into the
 * signature, so different-href / different-attr notes stay separate. We do NOT
 * change `footnoteContentKey` itself: it is shared with the live
 * `insertInlineFootnote` / `commentsToFootnotes` dedup and altering it there
 * would change their behaviour — out of scope here.
 *
 * The TEXT portion mirrors `footnoteContentKey` exactly (per text node
 * `text + mark-signature`, concatenated, whitespace-collapsed, trimmed) over the
 * already-in-place-normalized text, so empty text still yields "" (empties never
 * collapse) and merge parity with the rest of the pass is preserved.
 */
function footnoteMergeKey(defNode: any): string {
  const parts: string[] = [];
  const visit = (n: any): void => {
    if (!n || typeof n !== "object") return;
    if (n.type === "text" && typeof n.text === "string") {
      const marks = Array.isArray(n.marks)
        ? n.marks
            .filter((m: any) => m && m.type)
            .map((m: any) => `${m.type}${stableAttrs(m.attrs)}`)
            .sort()
            .join(",")
        : "";
      parts.push(`${n.text}${marks}`);
    }
    if (Array.isArray(n.content)) for (const c of n.content) visit(c);
  };
  visit(defNode);
  return parts
    .join("")
    .replace(/[ \t\r\n]+/g, " ")
    .trim();
}

/**
 * Normalize footnote-definition text and merge definitions whose normalized
 * text (+ mark signature) matches. See the file header for the full contract.
 * Pure (deep-clones input, deterministic, idempotent). Intended to run
 * immediately BEFORE `canonicalizeFootnotes(doc)`.
 */
export function normalizeAndMergeFootnotes<T = any>(doc: T): T {
  if (doc == null || typeof doc !== "object") return doc;
  const out = cloneJson(doc) as any;

  // 1) All definitions in document order; normalize each one's text in place.
  const defNodes: any[] = [];
  collectDefinitions(out, defNodes);
  for (const def of defNodes) normalizeDefinitionText(def);

  // 2) Merge key per definition (normalized text + inline-mark signature). The
  //    first definition in document order per key wins; later ones map onto it.
  //    Empty-text definitions (key === "") are NOT merged — otherwise every
  //    empty footnote would collapse into one (parity with insertInlineFootnote).
  const keyToCanon = new Map<string, string>();
  const defIdToCanon = new Map<string, string>();
  for (const def of defNodes) {
    const id = def?.attrs?.id;
    if (typeof id !== "string" || id === "") continue;
    const key = footnoteMergeKey(def);
    if (key === "") continue;
    const canon = keyToCanon.get(key);
    if (canon === undefined) {
      keyToCanon.set(key, id);
    } else if (canon !== id) {
      defIdToCanon.set(id, canon);
    }
  }

  // 3) Re-hang references from duplicate ids onto the canonical id. Duplicate
  //    definitions keep their ids but now have no references -> the following
  //    canonicalizer pass drops them as orphans.
  if (defIdToCanon.size > 0) rehangReferences(out, defIdToCanon);

  return out;
}
