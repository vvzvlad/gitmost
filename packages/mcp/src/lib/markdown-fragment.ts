/**
 * Single-BLOCK markdown fragment support for `patch_node` / `insert_node`
 * (#413). These tools accept EITHER a raw ProseMirror `node` (fine attr/mark
 * work) OR a `markdown` string (the recommended default): a small markdown
 * fragment is run through the canonical importer, yielding the SAME topology a
 * full-page markdown import would — so a block written via markdown is
 * canonically identical to the same content imported whole (no "second canon").
 *
 * The importer produces a full `{type:"doc", content:[...blocks..., footnotesList?]}`.
 * A fragment write needs the BLOCKS separately from the footnote DEFINITIONS so
 * the caller can splice the blocks into the live document and merge the
 * definitions into the page's TAIL footnote list via the existing footnote
 * machinery (`insertInlineFootnote`'s `appendDefinition` + `canonicalizeFootnotes`).
 *
 * Footnote id-collision safety: the importer assigns sequential ids (`fn-1`,
 * `fn-2`, …) starting from 1 for EVERY fragment, so a fragment's `fn-1` would
 * collide with an existing page footnote also numbered `fn-1` — and
 * `canonicalizeFootnotes` matches references to definitions BY id, so the
 * fragment's reference would silently re-hang onto the page's unrelated
 * definition. To make the merge safe regardless of the page's current numbering,
 * every fragment footnote id is REMAPPED to a fresh uuid (via the importer's own
 * `generateFootnoteId`) across BOTH the references (inside the blocks) and the
 * definitions before either is handed back. Content-identical notes still merge
 * downstream via `normalizeAndMergeFootnotes` (content-key), and the whole doc is
 * renumbered by `canonicalizeFootnotes`, so the caller-visible numbering stays
 * canonical.
 */

import { markdownToProseMirror } from "./collaboration.js";
import { generateFootnoteId } from "@docmost/prosemirror-markdown";
import { docmostSchema } from "./docmost-schema.js";

/** True if `value` is a non-null, non-array object. */
function isObject(value: any): value is Record<string, any> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Deep-walk `node` collecting every footnote id it uses (on `footnoteReference`
 * and `footnoteDefinition` nodes) and build a stable OLD->NEW remap, minting a
 * fresh uuid per distinct old id. The map is shared across a fragment's blocks
 * and definitions so a reference and its definition receive the SAME new id.
 */
function buildFootnoteIdRemap(nodes: any[]): Map<string, string> {
  const remap = new Map<string, string>();
  const visit = (node: any): void => {
    if (!isObject(node)) return;
    if (
      (node.type === "footnoteReference" ||
        node.type === "footnoteDefinition") &&
      isObject(node.attrs) &&
      typeof node.attrs.id === "string" &&
      node.attrs.id !== ""
    ) {
      if (!remap.has(node.attrs.id)) {
        remap.set(node.attrs.id, generateFootnoteId());
      }
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) visit(child);
    }
  };
  for (const n of nodes) visit(n);
  return remap;
}

/** Rewrite every footnote id in `node` IN PLACE using `remap` (deep). */
function applyFootnoteIdRemap(node: any, remap: Map<string, string>): void {
  if (!isObject(node)) return;
  if (
    (node.type === "footnoteReference" || node.type === "footnoteDefinition") &&
    isObject(node.attrs) &&
    typeof node.attrs.id === "string"
  ) {
    const next = remap.get(node.attrs.id);
    if (next) node.attrs.id = next;
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) applyFootnoteIdRemap(child, remap);
  }
}

/**
 * Generate a short random block id for an imported block that arrives without one
 * (the markdown importer emits `attrs.id: null`). Mirrors the mcp `freshId`
 * convention (base36 random, unique within one document). The patch path then
 * OVERWRITES the first block's id with the target id; every other block keeps the
 * fresh id minted here — so a 1 -> N section rewrite yields addressable,
 * comment-anchorable blocks rather than a run of null-id paragraphs.
 */
function freshBlockId(): string {
  return (
    Math.random().toString(36).slice(2, 12) +
    Math.random().toString(36).slice(2, 6)
  );
}

/**
 * Assign a fresh id to every top-level block whose `attrs.id` is null/missing,
 * IN PLACE. Only the block's own id is touched (not descendants — those keep the
 * importer's structure). Ensures each imported block is independently addressable.
 */
function assignFreshBlockIds(blocks: any[]): void {
  for (const b of blocks) {
    if (!isObject(b)) continue;
    if (!isObject(b.attrs)) b.attrs = {};
    if (b.attrs.id == null || b.attrs.id === "") {
      b.attrs.id = freshBlockId();
    }
  }
}

/** The parsed shape of a markdown fragment: its blocks + footnote definitions. */
export interface MarkdownFragment {
  /** Top-level blocks, in order, with the trailing `footnotesList` removed. */
  blocks: any[];
  /**
   * The `footnoteDefinition` nodes lifted from the imported `footnotesList`, with
   * ids already remapped to match the references left inside `blocks`. Empty when
   * the fragment used no footnotes.
   */
  definitions: any[];
}

/**
 * Import a markdown fragment and return its blocks separately from its footnote
 * definitions, with all footnote ids remapped to fresh uuids (see the file
 * header). The importer's `^[body]` inline-footnote handling is used verbatim —
 * `^[...]` in the fragment is a first-class footnote, NOT rejected — so the
 * markdown path matches the full-page import exactly.
 *
 * Throws when the fragment imports to zero blocks (an empty / whitespace-only
 * markdown string is not a valid block write).
 */
export async function importMarkdownFragment(
  markdown: string,
): Promise<MarkdownFragment> {
  // #502: the fragment path is an MCP agent WRITE (patch_node/insert_node
  // markdown), so it uses the SAME extensions-OFF importer options as the
  // full-page write (markdownToProseMirrorCanonical): a `$…$` span stays literal
  // and a schemeless domain/email is not autolinked. This keeps a block written
  // via markdown canonically identical to the same content in a full-page write
  // (no "second canon"). Explicit `https://…` links and block structure are
  // unaffected.
  const doc = await markdownToProseMirror(markdown, {
    parseMath: false,
    fuzzyLinkify: false,
  });
  const content: any[] = Array.isArray(doc?.content) ? doc.content : [];

  const blocks: any[] = [];
  const definitions: any[] = [];
  for (const node of content) {
    if (isObject(node) && node.type === "footnotesList") {
      // Lift the definitions out of the list; the list wrapper itself is
      // reconstructed on the page by the canonicalizer after the merge.
      if (Array.isArray(node.content)) {
        for (const def of node.content) {
          if (isObject(def) && def.type === "footnoteDefinition") {
            definitions.push(def);
          }
        }
      }
      continue;
    }
    blocks.push(node);
  }

  if (blocks.length === 0) {
    throw new Error(
      "markdown fragment produced no blocks — provide non-empty markdown, or use `node` for a raw ProseMirror node",
    );
  }

  // Remap footnote ids across BOTH blocks and definitions so a fragment `fn-1`
  // cannot collide with a page footnote of the same number.
  const remap = buildFootnoteIdRemap([...blocks, ...definitions]);
  if (remap.size > 0) {
    for (const b of blocks) applyFootnoteIdRemap(b, remap);
    for (const d of definitions) applyFootnoteIdRemap(d, remap);
  }

  // Every top-level block needs a stable id (the importer leaves them null). The
  // patch path OVERWRITES the first block's id with the target id afterwards.
  assignFreshBlockIds(blocks);

  return { blocks, definitions };
}

/**
 * True when `type` is a valid TOP-LEVEL child of the document node per the
 * canonical schema's content model — i.e. `get_node` can serialize it to
 * markdown by wrapping it in `{type:"doc",content:[node]}`. Derived from the
 * schema's `doc` contentMatch (NOT a hand-written type list) so it tracks the
 * schema automatically: `tableRow`/`tableCell`/`tableHeader` (addressed only via
 * `#<index>`) are NOT doc children and yield false, so `get_node` auto-falls back
 * to JSON for them.
 */
export function canBeDocChild(type: string | undefined): boolean {
  if (typeof type !== "string") return false;
  const nodeType = docmostSchema.nodes[type];
  if (!nodeType) return false;
  return docmostSchema.nodes.doc.contentMatch.matchType(nodeType) != null;
}

/**
 * Table-cell attributes that CANNOT survive a markdown round-trip: the converter
 * emits colspan/rowspan (and align) as HTML `<table>` cell attrs, but silently
 * drops `colwidth`, `backgroundColor`, and `backgroundColorName`. A markdown
 * `patch_node` on a block that carries any of these (a merged / colored /
 * fixed-width cell) would therefore lose them — so it is REJECTED, pointing the
 * caller at the table tools or the raw-`node` JSON path. `align` is intentionally
 * absent: it round-trips as GFM alignment.
 */
function cellCarriesUnrepresentableAttrs(node: any): boolean {
  if (!isObject(node)) return false;
  if (node.type !== "tableCell" && node.type !== "tableHeader") return false;
  const a = isObject(node.attrs) ? node.attrs : {};
  if ((a.colspan ?? 1) > 1) return true;
  if ((a.rowspan ?? 1) > 1) return true;
  if (a.colwidth != null) return true;
  if (a.backgroundColor != null) return true;
  if (a.backgroundColorName != null) return true;
  return false;
}

/**
 * Scan a target block (the node being replaced) for any table cell carrying an
 * attribute markdown cannot represent (colspan/rowspan/colwidth/background). When
 * one is found, return a human-readable list of the offending attr NAMES so the
 * caller can build an actionable rejection message; return null when the block is
 * safe to rewrite from markdown. Deep — a colored cell nested inside a table
 * inside a callout is still caught.
 */
export function findUnrepresentableTableAttrs(node: any): string | null {
  const found = new Set<string>();
  const visit = (n: any): void => {
    if (!isObject(n)) return;
    if (cellCarriesUnrepresentableAttrs(n)) {
      const a = isObject(n.attrs) ? n.attrs : {};
      if ((a.colspan ?? 1) > 1) found.add("colspan");
      if ((a.rowspan ?? 1) > 1) found.add("rowspan");
      if (a.colwidth != null) found.add("colwidth");
      if (a.backgroundColor != null) found.add("backgroundColor");
      if (a.backgroundColorName != null) found.add("backgroundColorName");
    }
    if (Array.isArray(n.content)) {
      for (const child of n.content) visit(child);
    }
  };
  visit(node);
  return found.size > 0 ? Array.from(found).sort().join(", ") : null;
}
