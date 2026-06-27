import {
  FOOTNOTE_REFERENCE_NAME,
  FOOTNOTES_LIST_NAME,
  FOOTNOTE_DEFINITION_NAME,
  deriveFootnoteId,
} from './footnote-util';

/**
 * Server-side, EditorView-free port of the footnote integrity invariant that
 * `footnoteSyncPlugin` maintains in the live editor. Where the plugin is an
 * `appendTransaction` that only runs inside a ProseMirror `EditorView`, this is
 * a PURE function over ProseMirror JSON: `canonicalizeFootnotes(doc) -> doc`.
 *
 * It exists because every NON-editor write path (the MCP `markdownToProseMirror`
 * importer, `update_page_json`, `docmost_transform`, the future git-sync writer)
 * builds ProseMirror JSON directly via `TiptapTransformer`/`updateYFragment`,
 * which NEVER runs the editor's plugins — so the canonical footnote topology was
 * never enforced on those writes. That is the root cause of the symptom in the
 * issue: footnotes rendered out of order (`1, 4, 2, 3, …`), a raw trailing
 * `[^id]: …` block, and orphan definitions, all of which are simply the result
 * of content written PAST the canonicalizer.
 *
 * The desired end-state (identical to the plugin's) is:
 *
 *   1. Reference ids in DOCUMENT ORDER are the single source of truth for which
 *      definitions exist and in what order (numbering is derived from this, see
 *      `computeFootnoteNumbers`). Repeated references that share an id are REUSE
 *      (one footnote, one number, one definition) — never re-id'd.
 *   2. Exactly ONE `footnotesList`, holding one definition per referenced id in
 *      REFERENCE order, reusing the existing definition node (content preserved)
 *      or synthesizing an empty one when missing. The list sits after the last
 *      meaningful block (only trailing empty paragraphs may follow it).
 *   3. Orphan definitions (no matching reference) are dropped.
 *   4. Duplicate DEFINITIONS (two nodes sharing an id) are resolved
 *      deterministically: the first keeps the id; each later duplicate is re-id'd
 *      via `deriveFootnoteId` (never random) so it is never silently lost — and,
 *      lacking a matching reference, it then falls under the orphan policy and is
 *      dropped. This matches the editor's never-lose-by-collision rule and the
 *      importer's first-wins rule (both converge to "one definition per id").
 *   5. Idempotent: a document that already satisfies the invariant is returned
 *      structurally unchanged (the existing definition/list nodes are reused
 *      verbatim), so re-running the canonicalizer — or running it on a write that
 *      the editor already canonicalized — is a no-op. This is what makes it safe
 *      to wire into EVERY write path without spurious mutations / git-sync churn.
 *
 * Divergence from the live plugin (intentional): the plugin preserves the
 * PHYSICAL order of existing definition nodes to keep their Yjs/CRDT subtree
 * identity stable across collaborators (numbering is decoration-derived, so the
 * displayed numbers are correct regardless of physical order). This function has
 * no live CRDT to protect, so it physically REORDERS the list into reference
 * order — which is exactly the repair the out-of-order import needs. On every
 * editor-reachable steady state (where the list is already reference-ordered) the
 * two agree byte-for-byte; see the golden test.
 *
 * Pure: deep-clones its input, never mutates the caller's object, and is
 * deterministic (no `Math.random`/`Date.now`).
 */
export function canonicalizeFootnotes<T = any>(doc: T): T {
  if (
    doc == null ||
    typeof doc !== 'object' ||
    !Array.isArray((doc as any).content)
  ) {
    return doc;
  }
  const out = cloneJson(doc) as any;

  // 1) Distinct reference ids in document order (deep — references can live in
  //    callouts, tables, list items, ...). This is the ordering/numbering truth.
  const referenceIds: string[] = [];
  const seenRefIds = new Set<string>();
  collectReferenceIds(out, referenceIds, seenRefIds);

  // 2) Every definition node in document order (deep — defs normally live inside
  //    one or more `footnotesList` blocks, but we tolerate stray placements).
  const defNodes: any[] = [];
  collectDefinitions(out, defNodes);

  // 3) Resolve the id topology deterministically. The first definition for an id
  //    keeps it; a later duplicate is re-id'd to a fresh derived id (never lost),
  //    which — having no matching reference — is dropped as an orphan in step 4.
  const taken = new Set<string>(referenceIds);
  for (const d of defNodes) {
    const id = d?.attrs?.id;
    if (id) taken.add(id);
  }
  const occurrenceOf = new Map<string, number>();
  const seenDefIds = new Set<string>();
  // finalId -> definition node (the node reference inside `out`).
  const defByFinalId = new Map<string, any>();
  for (const d of defNodes) {
    const origId = d?.attrs?.id;
    if (!origId) continue;
    if (!seenDefIds.has(origId)) {
      seenDefIds.add(origId);
      defByFinalId.set(origId, d);
    } else {
      const next = (occurrenceOf.get(origId) ?? 1) + 1;
      occurrenceOf.set(origId, next);
      const newId = deriveFootnoteId(origId, next, taken);
      taken.add(newId);
      defByFinalId.set(newId, d);
    }
  }

  // 4) Build the ordered definition list: one per referenced id, in REFERENCE
  //    order, reusing the existing node (content preserved, id normalized) or
  //    synthesizing an empty definition. Definitions whose final id is NOT
  //    referenced are orphans and are simply never added.
  const orderedDefs: any[] = [];
  for (const id of referenceIds) {
    const existing = defByFinalId.get(id);
    if (existing) {
      const node = cloneJson(existing);
      node.attrs = { ...(node.attrs ?? {}), id };
      orderedDefs.push(node);
    } else {
      orderedDefs.push(emptyDefinition(id));
    }
  }

  // 5) Strip every existing top-level footnotesList; we rebuild a single one.
  const top: any[] = out.content.filter(
    (n: any) => !(n && n.type === FOOTNOTES_LIST_NAME),
  );

  // 6) No references -> there must be NO list at all.
  if (referenceIds.length === 0) {
    out.content = top;
    return out;
  }

  // 7) Insert exactly one footnotesList after the last meaningful (non-empty
  //    paragraph) block, so it coexists with a trailing-node empty paragraph.
  let insertAt = top.length;
  while (insertAt > 0 && isEmptyParagraph(top[insertAt - 1])) insertAt--;
  top.splice(insertAt, 0, { type: FOOTNOTES_LIST_NAME, content: orderedDefs });
  out.content = top;
  return out;
}

/** A fresh empty definition node for a referenced id with no definition. */
function emptyDefinition(id: string): any {
  return {
    type: FOOTNOTE_DEFINITION_NAME,
    attrs: { id },
    content: [{ type: 'paragraph' }],
  };
}

function isEmptyParagraph(node: any): boolean {
  return (
    !!node &&
    node.type === 'paragraph' &&
    (!Array.isArray(node.content) || node.content.length === 0)
  );
}

/** Collect DISTINCT footnoteReference ids in document order (first appearance). */
function collectReferenceIds(
  node: any,
  out: string[],
  seen: Set<string>,
): void {
  if (!node || typeof node !== 'object') return;
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

/** Collect every footnoteDefinition node in document order. */
function collectDefinitions(node: any, out: any[]): void {
  if (!node || typeof node !== 'object') return;
  if (node.type === FOOTNOTE_DEFINITION_NAME) out.push(node);
  if (Array.isArray(node.content)) {
    for (const child of node.content) collectDefinitions(child, out);
  }
}

function cloneJson<T>(v: T): T {
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v)) as T;
}
