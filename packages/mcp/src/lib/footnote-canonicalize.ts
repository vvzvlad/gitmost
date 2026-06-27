/**
 * Server-side footnote canonicalizer (MCP mirror — PURE).
 *
 * `canonicalizeFootnotes(doc)` is a pure ProseMirror-JSON port of the editor's
 * `footnoteSyncPlugin` end-state, identical in behaviour to
 * `@docmost/editor-ext`'s `canonicalizeFootnotes`. It is mirrored here — rather
 * than imported from editor-ext — for the SAME reason `footnote-lex.ts` and the
 * `docmost-schema.ts` nodes are mirrored: the MCP package is deliberately
 * decoupled from the browser/React-heavy editor barrel and operates on plain
 * JSON. The editor-ext copy owns the golden test against the live plugin; this
 * copy must stay behaviourally identical (a SHARED golden corpus, exercised by
 * both test suites, pins that — see `test/unit/footnote-corpus.mjs`).
 *
 * This module is the pure MIRROR only. The inline-authoring helpers
 * (`footnoteContentKey`, `makeFootnoteDefinition`, `generateFootnoteId`) used by
 * `insertInlineFootnote` live in the sibling `footnote-authoring.ts`, so this
 * file is compositionally symmetric to the editor-ext copy.
 *
 * Why it exists: every NON-editor write path (markdown import, update_page_json,
 * docmost_transform, insert_footnote) builds ProseMirror JSON directly, so the
 * editor's footnote plugins never run and the canonical topology (sequential
 * numbering by first reference, one trailing list, no orphans, no raw `[^id]`)
 * was never enforced. Running this at the end of every write path closes that
 * gap; because it is idempotent, it is a no-op when the footnotes are already
 * canonical (no spurious mutations / git-sync churn).
 */

const FOOTNOTE_REFERENCE_NAME = "footnoteReference";
const FOOTNOTES_LIST_NAME = "footnotesList";
const FOOTNOTE_DEFINITION_NAME = "footnoteDefinition";

function cloneJson<T>(v: T): T {
  if (typeof structuredClone === "function") return structuredClone(v);
  return JSON.parse(JSON.stringify(v)) as T;
}

function isEmptyParagraph(node: any): boolean {
  return (
    !!node &&
    node.type === "paragraph" &&
    (!Array.isArray(node.content) || node.content.length === 0)
  );
}

function collectReferenceIds(node: any, out: string[], seen: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (node.type === FOOTNOTE_REFERENCE_NAME) {
    const id = node?.attrs?.id;
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) collectReferenceIds(child, out, seen);
  }
}

function collectDefinitions(node: any, out: any[]): void {
  if (!node || typeof node !== "object") return;
  if (node.type === FOOTNOTE_DEFINITION_NAME) out.push(node);
  if (Array.isArray(node.content)) {
    for (const child of node.content) collectDefinitions(child, out);
  }
}

function emptyDefinition(id: string): any {
  return {
    type: FOOTNOTE_DEFINITION_NAME,
    attrs: { id },
    content: [{ type: "paragraph" }],
  };
}

/**
 * Deep equality over plain JSON: arrays are compared POSITIONALLY
 * (order-SENSITIVE), object keys order-insensitively. The array order-sensitivity
 * is required for correctness here — a reordered `footnotesList.content` must
 * compare UNEQUAL so the canonical rebuild fires instead of leaving it in place.
 */
function deepEqualJson(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualJson(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqualJson(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Canonicalize footnotes in a ProseMirror-JSON document. See the file header and
 * the editor-ext twin for the full contract. Pure (deep-clones input,
 * deterministic, idempotent).
 */
export function canonicalizeFootnotes<T = any>(doc: T): T {
  if (
    doc == null ||
    typeof doc !== "object" ||
    !Array.isArray((doc as any).content)
  ) {
    return doc;
  }
  const out = cloneJson(doc) as any;

  // 1) Distinct reference ids in document order (deep — refs can live in
  //    callouts, tables, list items, ...). The ordering/numbering truth.
  const referenceIds: string[] = [];
  collectReferenceIds(out, referenceIds, new Set<string>());

  // 2) Every definition node in document order (deep).
  const defNodes: any[] = [];
  collectDefinitions(out, defNodes);

  // 3) First definition per id wins; later duplicates carry the SAME id, so they
  //    cannot be referenced separately and would be orphans — they are dropped.
  const defById = new Map<string, any>();
  for (const d of defNodes) {
    const id = d?.attrs?.id;
    if (id && !defById.has(id)) defById.set(id, d);
  }

  // 4) Build the ordered definition list: one per referenced id, in REFERENCE
  //    order, reusing the existing node (shallow-copied, id normalized — `out` is
  //    already deep-cloned and the old lists are cut) or synthesizing an empty
  //    one. Definitions whose id is not referenced are orphans and never added.
  const orderedDefs: any[] = [];
  for (const id of referenceIds) {
    const existing = defById.get(id);
    if (existing) {
      orderedDefs.push({
        ...existing,
        attrs: { ...(existing.attrs ?? {}), id },
      });
    } else {
      orderedDefs.push(emptyDefinition(id));
    }
  }

  // 5) No references -> there must be NO list at all (at any depth).
  if (referenceIds.length === 0) {
    stripFootnotesListsDeep(out);
    return out;
  }

  // 6) Placement parity with the live plugin: when the document is ALREADY in the
  //    canonical single-list state, leave that list exactly where it sits rather
  //    than cutting and re-inserting it at the end (the plugin never repositions a
  //    sole correct list, so moving it would silently reorder any content that
  //    follows the list on the first write).
  const topLevelLists = out.content.filter(
    (n: any) => n && n.type === FOOTNOTES_LIST_NAME,
  );
  if (
    topLevelLists.length === 1 &&
    defNodes.length === orderedDefs.length &&
    deepEqualJson(topLevelLists[0].content, orderedDefs)
  ) {
    return out;
  }

  // 7) Otherwise rebuild: strip every footnotesList at ANY depth (collectDefinitions
  //    gathers defs recursively, so a list nested in a callout/blockquote would
  //    otherwise have its defs copied into the new list while the original
  //    survives — duplicates) and re-insert exactly one after the last meaningful
  //    (non-empty paragraph) top-level block.
  stripFootnotesListsDeep(out);
  const top: any[] = out.content;
  let insertAt = top.length;
  while (insertAt > 0 && isEmptyParagraph(top[insertAt - 1])) insertAt--;
  top.splice(insertAt, 0, { type: FOOTNOTES_LIST_NAME, content: orderedDefs });
  out.content = top;
  return out;
}

/** Remove every `footnotesList` node at ANY depth (mutates the given clone). */
function stripFootnotesListsDeep(node: any): void {
  if (!node || typeof node !== "object" || !Array.isArray(node.content)) return;
  node.content = node.content.filter(
    (c: any) => !(c && c.type === FOOTNOTES_LIST_NAME),
  );
  for (const child of node.content) stripFootnotesListsDeep(child);
}
