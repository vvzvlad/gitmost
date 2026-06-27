import {
  FOOTNOTE_REFERENCE_NAME,
  FOOTNOTES_LIST_NAME,
  FOOTNOTE_DEFINITION_NAME,
} from './footnote-util';

/**
 * Server-side, EditorView-free port of the footnote integrity invariant that
 * `footnoteSyncPlugin` maintains in the live editor. Where the plugin is an
 * `appendTransaction` that only runs inside a ProseMirror `EditorView`, this is
 * a PURE function over ProseMirror JSON: `canonicalizeFootnotes(doc) -> doc`.
 *
 * It exists because the NON-editor write paths served by THIS copy build
 * ProseMirror JSON directly (never running the editor's plugins), so the
 * canonical footnote topology was never enforced on those writes. The consumers
 * of this editor-ext copy are: the server markdown/HTML import
 * (`markdownToHtml -> htmlToJson` in import.service / file-import-task.service),
 * `PageService` create/update (`parseProsemirrorContent` for the JSON/markdown/
 * HTML REST write paths), and the client markdown PASTE path
 * (`markdown-clipboard.ts`). (The MCP package mirrors this canonicalizer in
 * `packages/mcp/src/lib/footnote-canonicalize.ts` for its own write paths —
 * `markdownToProseMirror`, `update_page_json`, `docmost_transform`,
 * `insert_footnote` — see that file's header.) All of these are the root cause
 * of the symptom in the issue: footnotes rendered out of order (`1, 4, 2, 3, …`),
 * a raw trailing `[^id]: …` block, and orphan definitions, all of which are
 * simply the result of content written PAST the canonicalizer.
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
 *   4. Duplicate DEFINITIONS (two nodes sharing an id) are resolved first-wins:
 *      the first definition for an id is kept; later duplicates carry the SAME
 *      id, so they can never be referenced separately and are simply dropped.
 *      This matches the importer's first-wins rule ("one definition per id").
 *      (The LIVE editor instead re-id's a duplicate definition so a paste/collab
 *      merge cannot silently lose live user data; the artifacts this copy
 *      sanitizes are agent/import-authored, so first-wins is the right policy —
 *      see footnote-sync.ts `resolveCollisions`.)
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
 * no live CRDT to protect, so when a REPAIR is needed it physically REORDERS the
 * list into reference order — which is exactly the fix the out-of-order import
 * needs.
 *
 * Placement PARITY with the plugin: when the document is already in the canonical
 * single-list state, this function leaves that list EXACTLY where it sits (it
 * does not move it to the end). The plugin behaves the same — it treats one
 * footnotesList holding the canonical definition set as canonical regardless of
 * whether content follows it (footnote-sync.ts: `primaryList` falls back to the
 * last list and `noChangeNeeded` stays true). So on every editor-reachable steady
 * state the two agree byte-for-byte, including when non-empty content follows the
 * list; see the golden parity test and the shared corpus.
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

  // 3) First definition per id wins. Later duplicates carry the SAME id, so they
  //    can never be referenced separately and would be orphans — they are simply
  //    dropped (first-wins; see the file header, item 4).
  const defById = new Map<string, any>();
  for (const d of defNodes) {
    const id = d?.attrs?.id;
    if (id && !defById.has(id)) defById.set(id, d);
  }

  // 4) Build the ordered definition list: one per referenced id, in REFERENCE
  //    order, reusing the existing node (content preserved, id normalized) or
  //    synthesizing an empty definition. Definitions whose id is NOT referenced
  //    are orphans and are simply never added. The reused node is SHALLOW-copied
  //    (id normalized): `out` is already a deep clone and the old lists are cut,
  //    so a second per-definition deep clone is needless.
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
  //    canonical single-list state, leave that list exactly where it sits instead
  //    of cutting and re-inserting it at the end. The plugin never repositions a
  //    sole correct list (footnote-sync.ts), so moving it here would silently
  //    reorder any user content that follows the list on the first write. The doc
  //    is in that state when there is exactly one top-level footnotesList, every
  //    definition in the doc is referenced (no orphans / duplicates: the def count
  //    equals the canonical count), and the list already holds exactly the
  //    canonical definitions in reference order.
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
  //    (non-empty paragraph) top-level block, so it coexists with a trailing-node
  //    empty paragraph. This both repairs a non-canonical doc and (in the import
  //    case) physically reorders the list into reference order.
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
  if (!node || typeof node !== 'object' || !Array.isArray(node.content)) return;
  node.content = node.content.filter(
    (c: any) => !(c && c.type === FOOTNOTES_LIST_NAME),
  );
  for (const child of node.content) stripFootnotesListsDeep(child);
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
  if (typeof a === 'object') {
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
