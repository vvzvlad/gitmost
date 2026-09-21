/**
 * Pure, network-free helpers for manipulating a ProseMirror/TipTap document
 * tree by node id.
 *
 * A ProseMirror node here is a plain JSON object of the shape produced by
 * Docmost: `{ type, attrs?, content?, text?, marks? }`. Children live in the
 * `content` array; a node carries a stable id in `attrs.id`. Callouts and
 * table cells hold their children in `content` just like any other block, so a
 * single recursive walk reaches them all.
 *
 * Every exported function operates on a DEEP CLONE of the input document and
 * returns the new document. The input doc and any `newNode`/`node` argument are
 * never mutated. All functions are defensively null-safe: missing/!Array
 * `content`, non-object nodes, and absent `attrs` are tolerated.
 */

import { getSchema } from "@tiptap/core";
import { stripInlineMarkdown } from "./text-normalize.js";
import { docmostExtensions } from "./docmost-schema.js";

/** Deep-clone a JSON-serializable value without mutating the original. */
function clone<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  // Fallback for environments without structuredClone.
  return JSON.parse(JSON.stringify(value)) as T;
}

/** True if `value` is a non-null object (and not an array). */
function isObject(value: any): value is Record<string, any> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** True if `node` carries the given id in `node.attrs.id`. */
function matchesId(node: any, nodeId: string): boolean {
  return isObject(node) && isObject(node.attrs) && node.attrs.id === nodeId;
}

/**
 * Recursively concatenate all text contained in a node.
 *
 * Text nodes contribute their `text` string; container nodes contribute the
 * joined `blockPlainText` of their `content` children. Returns "" for nullish
 * or non-object inputs.
 */
export function blockPlainText(node: any): string {
  if (!isObject(node)) return "";
  let out = "";
  if (typeof node.text === "string") {
    out += node.text;
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      out += blockPlainText(child);
    }
  }
  return out;
}

/** Truncate `text` to at most `n` chars, appending an ellipsis when cut. */
function truncate(text: string, n: number): string {
  return text.length > n ? text.slice(0, n) + "…" : text;
}

/** One compact outline entry for a single top-level block. */
export interface OutlineEntry {
  index: number;
  type: string | undefined;
  id: string | null;
  firstText: string;
  /** Present for headings only. */
  level?: number | null;
  /** Present for tables only. */
  rows?: number;
  cols?: number;
  header?: string[];
  /** Present for list blocks only (bulletList/orderedList/taskList). */
  items?: number;
}

/**
 * Build a COMPACT outline of the TOP-LEVEL blocks of `doc` (the entries in
 * `doc.content`). Deliberately does NOT recurse into paragraphs, list items, or
 * table cells — compactness is the point; use `getNodeByRef` to drill into a
 * specific block.
 *
 * Each entry carries `{ index, type, id, firstText }`, plus type-specific
 * extras: headings add `level`; tables add `rows`/`cols` and the first row's
 * cell texts as `header`; list blocks (types ending in "List") add `items`.
 * `firstText` is the block's plain text truncated to 100 chars. Null-safe:
 * a missing or non-object doc/content yields `[]`.
 */
export function buildOutline(doc: any): OutlineEntry[] {
  if (!isObject(doc) || !Array.isArray(doc.content)) return [];

  const out: OutlineEntry[] = [];
  for (let i = 0; i < doc.content.length; i++) {
    const block = doc.content[i];
    const type = isObject(block) ? block.type : undefined;
    const entry: OutlineEntry = {
      index: i,
      type,
      id:
        isObject(block) && isObject(block.attrs)
          ? (block.attrs.id ?? null)
          : null,
      firstText: truncate(blockPlainText(block), 100),
    };

    if (type === "heading") {
      entry.level = isObject(block.attrs) ? (block.attrs.level ?? null) : null;
    } else if (type === "table") {
      const headerRow = block.content?.[0]?.content ?? [];
      entry.rows = block.content?.length ?? 0;
      entry.cols = block.content?.[0]?.content?.length ?? 0;
      entry.header = headerRow.map((cell: any) =>
        truncate(blockPlainText(cell), 40),
      );
    } else if (typeof type === "string" && type.endsWith("List")) {
      entry.items = block.content?.length ?? 0;
    }

    out.push(entry);
  }
  return out;
}

/**
 * Resolve a single node by reference and return `{ node, path, type }`, or
 * `null` when nothing matches.
 *
 * - `ref` of the form `#<n>` (e.g. `#2`) selects the TOP-LEVEL block at index
 *   `n` in `doc.content`. This is the only way to address table/tableRow/
 *   tableCell nodes, which carry no `attrs.id`.
 * - Otherwise `ref` is treated as a block id: the FIRST node anywhere in the
 *   tree with `attrs.id === ref` is returned.
 *
 * `path` is the array of child indices from the doc root down to the node
 * (so a top-level block is `[index]`). The returned `node` is a DEEP CLONE,
 * so callers can mutate it without touching the input doc. Null-safe.
 */
export function getNodeByRef(
  doc: any,
  ref: string,
): { node: any; path: number[]; type: string | undefined } | null {
  if (!isObject(doc)) return null;

  // "#<n>": index into the top-level content array.
  const indexMatch = typeof ref === "string" ? ref.match(/^#(\d+)$/) : null;
  if (indexMatch) {
    const index = Number(indexMatch[1]);
    const block = Array.isArray(doc.content) ? doc.content[index] : undefined;
    if (!isObject(block)) return null;
    return { node: clone(block), path: [index], type: block.type };
  }

  // Otherwise: depth-first search for the first node with attrs.id === ref.
  const search = (
    node: any,
    trail: number[],
  ): { node: any; path: number[]; type: string } | null => {
    if (!isObject(node)) return null;
    if (Array.isArray(node.content)) {
      for (let i = 0; i < node.content.length; i++) {
        const child = node.content[i];
        const path = [...trail, i];
        if (matchesId(child, ref)) {
          return { node: clone(child), path, type: child.type };
        }
        const hit = search(child, path);
        if (hit != null) return hit;
      }
    }
    return null;
  };

  return search(doc, []);
}

/**
 * Replace EVERY node whose `attrs.id === nodeId` with a deep clone of
 * `newNode`, anywhere in the tree (including inside callouts and table cells).
 *
 * Operates on a clone of `doc`; returns `{ doc, replaced }` where `replaced`
 * is the number of nodes substituted. A fresh clone of `newNode` is used for
 * each match so they do not share references.
 */
export function replaceNodeById(
  doc: any,
  nodeId: string,
  newNode: any,
): { doc: any; replaced: number } {
  const out = clone(doc);
  let replaced = 0;

  // Walk a content array, replacing direct matches and recursing into the
  // (possibly new) children of non-matching nodes.
  const walkContent = (content: any[]): void => {
    for (let i = 0; i < content.length; i++) {
      const child = content[i];
      if (matchesId(child, nodeId)) {
        content[i] = clone(newNode);
        replaced++;
        // Do not recurse into a freshly substituted node.
        continue;
      }
      if (isObject(child) && Array.isArray(child.content)) {
        walkContent(child.content);
      }
    }
  };

  if (isObject(out) && Array.isArray(out.content)) {
    walkContent(out.content);
  }
  return { doc: out, replaced };
}

/**
 * Splice a SINGLE node whose `attrs.id === nodeId` with an ORDERED ARRAY of new
 * nodes (a "1 -> N" replacement), anywhere in the tree. Used by the markdown
 * patch path, where importing a markdown fragment can yield several blocks that
 * must replace one existing block in place ("rewrite a section" in one call).
 *
 * Unlike `replaceNodeById` (which substitutes EVERY match), this walks to the
 * FIRST match only and splices `newNodes` in its position, so ordering and the
 * neighbouring blocks are preserved byte-for-byte. It deliberately does NOT
 * touch further duplicates: the caller (#159 semantics) must have already
 * verified the id is unambiguous via a `replaceNodeById` dry pass, so a single
 * splice here is safe and every other block is untouched.
 *
 * Each entry of `newNodes` is deep-cloned so they never share references with
 * each other or with the caller\'s array. Operates on a clone of `doc`; returns
 * `{ doc, replaced }` where `replaced` is 1 when a match was spliced, else 0.
 */
export function replaceNodeByIdWithMany(
  doc: any,
  nodeId: string,
  newNodes: any[],
): { doc: any; replaced: number } {
  const out = clone(doc);
  const fresh = Array.isArray(newNodes) ? newNodes.map((n) => clone(n)) : [];
  let replaced = 0;

  // Walk to the FIRST match and splice the array in its place; stop afterwards.
  const walkContent = (content: any[]): boolean => {
    for (let i = 0; i < content.length; i++) {
      const child = content[i];
      if (matchesId(child, nodeId)) {
        content.splice(i, 1, ...fresh);
        replaced = 1;
        return true;
      }
      if (isObject(child) && Array.isArray(child.content)) {
        if (walkContent(child.content)) return true;
      }
    }
    return false;
  };

  if (isObject(out) && Array.isArray(out.content)) {
    walkContent(out.content);
  }
  return { doc: out, replaced };
}

/**
 * Remove EVERY node whose `attrs.id === nodeId` from its parent `content`
 * array, anywhere in the tree (recursive, including callouts and tables).
 *
 * Operates on a clone of `doc`; returns `{ doc, deleted }` where `deleted` is
 * the number of nodes removed.
 */
export function deleteNodeById(
  doc: any,
  nodeId: string,
): { doc: any; deleted: number } {
  const out = clone(doc);
  let deleted = 0;

  // Filter a content array in place, dropping matches and recursing into the
  // surviving children.
  const walkContent = (content: any[]): any[] => {
    const kept: any[] = [];
    for (const child of content) {
      if (matchesId(child, nodeId)) {
        deleted++;
        continue;
      }
      if (isObject(child) && Array.isArray(child.content)) {
        child.content = walkContent(child.content);
      }
      kept.push(child);
    }
    return kept;
  };

  if (isObject(out) && Array.isArray(out.content)) {
    out.content = walkContent(out.content);
  }
  return { doc: out, deleted };
}

/**
 * Throw a clear, model-actionable error when a node-id write op did NOT match
 * exactly one node (#159). `count === 0` -> "no node found"; `count > 1` ->
 * "ambiguous, refused" — Docmost duplicates block ids on copy/paste, so a write
 * by id could clobber/remove EVERY duplicate. The caller skips the write for any
 * `count !== 1` (the transform returns null), so this only REPORTS; nothing was
 * changed. No-op for the unambiguous single-match case.
 */
export function assertUnambiguousMatch(
  op: "patchNode" | "deleteNode",
  verb: "replace" | "delete",
  count: number,
  nodeId: string,
  pageId: string,
): void {
  if (count === 0) {
    throw new Error(
      `${op}: no node with id "${nodeId}" found on page ${pageId}`,
    );
  }
  if (count > 1) {
    throw new Error(
      `${op}: id "${nodeId}" is ambiguous — ${count} nodes on page ${pageId} share it (block ids are duplicated on copy/paste). Refusing to ${verb} all of them; nothing was changed. Re-target with a more specific anchor.`,
    );
  }
}

/**
 * Deep-clone `doc` and strip every node/mark attribute whose value is strictly
 * `undefined`, so the result is safe to hand to Yjs (which throws an opaque
 * "Unexpected content type" when asked to store an `undefined` attribute value).
 *
 * Only `undefined` keys are removed; `null`, `false`, `0`, and `""` are all
 * legitimate JSON-storable values and are preserved. Operates on a clone and
 * returns it; the input is never mutated. Defensively null-safe like the rest
 * of the file.
 */
export function sanitizeForYjs(doc: any): any {
  const out = clone(doc);

  // Drop every key whose value is strictly `undefined` from an attrs object.
  const stripUndefined = (attrs: any): void => {
    if (!isObject(attrs)) return;
    for (const key of Object.keys(attrs)) {
      if (attrs[key] === undefined) {
        delete attrs[key];
      }
    }
  };

  const walk = (node: any): void => {
    if (!isObject(node)) return;
    stripUndefined(node.attrs);
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (isObject(mark)) stripUndefined(mark.attrs);
      }
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        walk(child);
      }
    }
  };

  walk(out);
  return out;
}

/**
 * Diagnostics helper: walk the tree and return a human-readable path string for
 * the FIRST attribute value (in any `node.attrs` or `mark.attrs`) that Yjs
 * cannot store — i.e. `undefined`, a `function`, a `symbol`, or a `bigint`
 * (e.g. `content[3].content[0].attrs.indent (undefined)`). Returns `null` when
 * every attribute is storable. Null-safe.
 */
export function findUnstorableAttr(doc: any): string | null {
  const isUnstorable = (value: any): string | null => {
    if (value === undefined) return "undefined";
    const t = typeof value;
    if (t === "function") return "function";
    if (t === "symbol") return "symbol";
    if (t === "bigint") return "bigint";
    return null;
  };

  // Check an attrs object; return the offending sub-path or null.
  const checkAttrs = (attrs: any, basePath: string): string | null => {
    if (!isObject(attrs)) return null;
    for (const key of Object.keys(attrs)) {
      const kind = isUnstorable(attrs[key]);
      if (kind != null) return `${basePath}.${key} (${kind})`;
    }
    return null;
  };

  const walk = (node: any, path: string): string | null => {
    if (!isObject(node)) return null;
    const attrHit = checkAttrs(node.attrs, `${path}.attrs`);
    if (attrHit != null) return attrHit;
    if (Array.isArray(node.marks)) {
      for (let i = 0; i < node.marks.length; i++) {
        const markHit = checkAttrs(
          node.marks[i]?.attrs,
          `${path}.marks[${i}].attrs`,
        );
        if (markHit != null) return markHit;
      }
    }
    if (Array.isArray(node.content)) {
      for (let i = 0; i < node.content.length; i++) {
        const childHit = walk(node.content[i], `${path}.content[${i}]`);
        if (childHit != null) return childHit;
      }
    }
    return null;
  };

  // The root doc node carries no useful index, so start the path at "doc".
  if (!isObject(doc)) return null;
  const attrHit = checkAttrs(doc.attrs, "attrs");
  if (attrHit != null) return attrHit;
  if (Array.isArray(doc.content)) {
    for (let i = 0; i < doc.content.length; i++) {
      const childHit = walk(doc.content[i], `content[${i}]`);
      if (childHit != null) return childHit;
    }
  }
  return null;
}

/**
 * The Docmost schema's known node and mark NAME sets, derived ONCE from the very
 * same `docmostExtensions` the Yjs encode path builds its schema from
 * (`getSchema(docmostExtensions)` — mirrored in mcp's `docmostSchema`). Deriving
 * both from the same extension list guarantees `findInvalidNode`'s "known type"
 * set matches exactly what `PMNode.fromJSON`/`toYdoc` will actually accept, so
 * the walker never flags a node the encoder would have stored (or vice versa).
 * Lazy + cached: the schema is only built on first use.
 */
let schemaNames: { nodes: Set<string>; marks: Set<string> } | null = null;
function getSchemaNames(): { nodes: Set<string>; marks: Set<string> } {
  if (schemaNames == null) {
    const schema = getSchema(docmostExtensions);
    schemaNames = {
      nodes: new Set(Object.keys(schema.nodes)),
      marks: new Set(Object.keys(schema.marks)),
    };
  }
  return schemaNames;
}

/**
 * Depth-first walk of the JSON `content` tree looking for the FIRST node whose
 * SHAPE the Yjs encode path will reject with an opaque
 * `Unknown node type: undefined` (issue #409). Returns `{ path, summary }` for
 * the offending node, or `null` when every node (and every mark) is a known
 * Docmost schema type.
 *
 * Two failure modes are detected, in order, per node:
 *   1. `type` is missing or not a string — the dominant `undefined` case, e.g.
 *      a text leaf written as `{"text":"foo"}` with no `"type":"text"`.
 *   2. `type` is a string but NOT a known Docmost node name (a typo / unknown
 *      block), OR one of the node's marks carries an unknown mark name.
 *
 * The returned `summary` is a model-actionable, path-anchored message such as:
 *   `node.content[2].content[0]: missing "type" (keys: text, marks) — did you
 *    mean {"type": "text", ...}?`
 * or for an unknown type:
 *   `node.content[1]: unknown node type "paragraf" — not in the Docmost schema`
 *
 * `path` is the same dotted JSON path used in the summary (e.g.
 * `node.content[2].content[0]`) so callers can surface it separately. Null-safe:
 * a non-object doc returns `null`.
 *
 * NOTE: This is a SHAPE check, not a full ProseMirror content-model validation
 * (it does not verify that a paragraph may legally contain a table, etc.). Its
 * job is to turn the specific "unknown/absent node type" Yjs crash into a clear,
 * pre-write diagnostic; the schema's own `.check()` still catches deeper
 * content-model violations at encode time.
 */
export function findInvalidNode(
  doc: any,
): { path: string; summary: string } | null {
  if (!isObject(doc)) return null;
  const { nodes, marks } = getSchemaNames();

  // Build the "did you mean" hint for a typeless node from its own keys, so the
  // model sees WHICH object is malformed and the canonical text-leaf fix.
  const keyHint = (node: Record<string, any>): string => {
    const keys = Object.keys(node);
    const looksLikeText =
      typeof node.text === "string" && node.type === undefined;
    const suffix = looksLikeText
      ? ` — did you mean {"type": "text", ...}?`
      : ` — every node needs a string "type" from the Docmost schema`;
    return `missing "type" (keys: ${keys.join(", ") || "none"})${suffix}`;
  };

  const walk = (
    node: any,
    path: string,
  ): { path: string; summary: string } | null => {
    if (!isObject(node)) return null;

    // (1) missing / non-string type.
    if (typeof node.type !== "string") {
      return { path, summary: `${path}: ${keyHint(node)}` };
    }
    // (2) string type that is not a known Docmost node.
    if (!nodes.has(node.type)) {
      return {
        path,
        summary: `${path}: unknown node type "${node.type}" — not in the Docmost schema`,
      };
    }
    // (2b) unknown mark on an otherwise-valid node.
    if (Array.isArray(node.marks)) {
      for (let i = 0; i < node.marks.length; i++) {
        const mark = node.marks[i];
        if (isObject(mark) && typeof mark.type === "string" && !marks.has(mark.type)) {
          return {
            path: `${path}.marks[${i}]`,
            summary: `${path}.marks[${i}]: unknown mark type "${mark.type}" — not in the Docmost schema`,
          };
        }
      }
    }

    if (Array.isArray(node.content)) {
      for (let i = 0; i < node.content.length; i++) {
        const hit = walk(node.content[i], `${path}.content[${i}]`);
        if (hit != null) return hit;
      }
    }
    return null;
  };

  // The root doc node is addressed as "node" (matching the mcp arg name); its
  // children are node.content[i]. The root itself is checked too so a typeless
  // root is reported rather than silently skipped.
  return walk(doc, "node");
}

/**
 * Table structural node types and the container each must live directly inside.
 * Used by `insertNodeRelative` to splice rows/cells into the correct ancestor
 * rather than blindly into the anchor's direct parent (which would corrupt the
 * table's nesting).
 */
const STRUCTURAL_TYPES = new Set(["tableRow", "tableCell", "tableHeader"]);
const REQUIRED_CONTAINER: Record<string, string> = {
  tableRow: "table",
  tableCell: "tableRow",
  tableHeader: "tableRow",
};

/**
 * Find the index of the first TOP-LEVEL block whose plain text includes the
 * anchor, with a markdown-stripping FALLBACK. Returns -1 when none matches.
 *
 * Two passes preserve "exact wins globally":
 *  - Pass 1: first block containing the verbatim `anchorText`.
 *  - Pass 2 (only if pass 1 found nothing): first block containing the
 *    markdown-stripped anchor, when stripping actually changed it.
 */
function findAnchorTextIndex(content: any[], anchorText: string): number {
  if (!Array.isArray(content)) return -1;
  // Pass 1: exact.
  for (let i = 0; i < content.length; i++) {
    if (blockPlainText(content[i]).includes(anchorText)) return i;
  }
  // Pass 2: markdown-stripped fallback.
  const a = stripInlineMarkdown(anchorText);
  if (a !== anchorText && a.length > 0) {
    for (let i = 0; i < content.length; i++) {
      if (blockPlainText(content[i]).includes(a)) return i;
    }
  }
  return -1;
}

/**
 * Locate an anchor and return its ancestor chain (from `doc` down to and
 * including the matched node). Each chain entry is `{ node, index }` where
 * `index` is the node's position inside its parent's `content` array (the root
 * doc has index -1). Returns `null` when the anchor cannot be resolved.
 */
function findAnchorChain(
  doc: any,
  opts: InsertOptions,
): { node: any; index: number }[] | null {
  if (!isObject(doc)) return null;

  // DFS by id anywhere in the tree, accumulating the path.
  if (opts.anchorNodeId != null) {
    const targetId = opts.anchorNodeId;
    const search = (
      node: any,
      index: number,
      trail: { node: any; index: number }[],
    ): { node: any; index: number }[] | null => {
      if (!isObject(node)) return null;
      const here = [...trail, { node, index }];
      if (matchesId(node, targetId)) return here;
      if (Array.isArray(node.content)) {
        for (let i = 0; i < node.content.length; i++) {
          const hit = search(node.content[i], i, here);
          if (hit != null) return hit;
        }
      }
      return null;
    };
    return search(doc, -1, []);
  }

  // By text: only top-level blocks are scanned (same rule as the JSON path).
  // Exact match wins; a markdown-stripped fallback is tried only on a miss.
  if (opts.anchorText != null && Array.isArray(doc.content)) {
    const i = findAnchorTextIndex(doc.content, opts.anchorText);
    if (i !== -1) {
      return [
        { node: doc, index: -1 },
        { node: doc.content[i], index: i },
      ];
    }
  }

  return null;
}

// ===========================================================================
// List seam coalescing (#535)
//
// When a markdown/JSON insert places a list block directly next to an existing
// sibling list of the SAME node type, the two must become ONE list (items
// appended/prepended) rather than two adjacent lists — otherwise the serializer
// correctly emits a `<!-- -->` separator between them (that separator is right
// for two genuinely-separate lists; the bug is that the extra sibling was ever
// created). Coalescing is STRICTLY LOCAL to the two seams of the active
// insertion — never a global "collapse all adjacent lists" normalization, which
// would destroy intentionally-separate lists elsewhere.
// ===========================================================================

/**
 * The three list container types we structurally coalesce at an insertion seam.
 * Deliberately an explicit set, NOT a `type.endsWith("List")` test — that also
 * matches `footnotesList`, which must NEVER be structurally merged.
 */
function isCoalescibleList(n: any): boolean {
  return (
    isObject(n) &&
    (n.type === "bulletList" ||
      n.type === "orderedList" ||
      n.type === "taskList")
  );
}

/**
 * True when two adjacent list nodes may have their ITEMS merged into one list.
 * Requires identical node type and, for orderedList, a compatible numbering
 * style: a missing/null `attrs.type` counts as the default, and the merge is
 * blocked ONLY when both lists carry an explicit, differing `attrs.type`.
 */
function listsMergeable(a: any, b: any): boolean {
  if (!isCoalescibleList(a) || !isCoalescibleList(b)) return false;
  if (a.type !== b.type) return false;
  if (!Array.isArray(a.content) || !Array.isArray(b.content)) return false;
  if (a.type === "orderedList") {
    const ta = a.attrs?.type ?? null;
    const tb = b.attrs?.type ?? null;
    if (ta != null && tb != null && ta !== tb) return false;
  }
  return true;
}

/**
 * Coalesce list seams around a freshly inserted run occupying indices `[i, j)`
 * in `parent`. At MOST the left seam (`parent[i-1]` ↔ `parent[i]`) and the right
 * seam (`parent[j-1]` ↔ `parent[j]`) are merged, each AT MOST ONCE — never a
 * `while (neighbours same type) merge` loop, which would swallow a further-out
 * intentionally-separate list. Mutates `parent` in place.
 *
 * Survivor choice is POSITIONAL, never by id: the neighbour OUTSIDE the `[i, j)`
 * range is pre-existing (the survivor, keeping its block id and list-level
 * attrs); the boundary block INSIDE the range is the freshly inserted list,
 * whose items move into the survivor and whose wrapper is then deleted
 * (appended when the survivor is on the left, prepended when on the right).
 *
 * Empty inserted list: if the inserted boundary list has zero items, its seam is
 * NOT coalesced — the block is left exactly as inserted.
 */
function coalesceSeams(parent: any[], i: number, j: number): void {
  if (!Array.isArray(parent)) return;
  const n = parent.length;

  const left = parent[i - 1];
  const boundaryLeft = parent[i];
  const boundaryRight = parent[j - 1];
  const right = parent[j];

  // A seam fires only when the pre-existing neighbour and the inserted boundary
  // list are mergeable AND the inserted boundary list is non-empty.
  const singleBlock = i === j - 1;
  const leftMergeable =
    i - 1 >= 0 &&
    listsMergeable(left, boundaryLeft) &&
    boundaryLeft.content.length > 0;
  let rightMergeable =
    j < n &&
    listsMergeable(boundaryRight, right) &&
    boundaryRight.content.length > 0;

  // Three-way collision: a SINGLE inserted list (singleBlock) landed exactly
  // between two pre-existing lists. The LEFT pre-existing list wins: the
  // inserted items then the right list's items fold into it, and both the
  // inserted wrapper and the right pre-existing list are deleted (the right
  // block id is NOT preserved — rare, documented).
  //
  // The `listsMergeable(left, right)` guard is REQUIRED: leftMergeable and
  // rightMergeable only check each PRE-EXISTING list against the inserted one.
  // A default-typed inserted orderedList is compatible with BOTH neighbours
  // even when the neighbours carry explicit DIFFERENT numbering styles, so
  // without this guard the two would collapse transitively through the middle
  // and the right list's style would be silently lost. When it fails we fall
  // through to the single-seam path below (never a transitive merge).
  if (singleBlock && leftMergeable && rightMergeable && listsMergeable(left, right)) {
    left.content.push(...boundaryLeft.content, ...right.content);
    parent.splice(i, 2);
    return;
  }

  // A single inserted block can be absorbed by at most ONE neighbour. When both
  // seams are individually valid but the neighbours are mutually incompatible
  // (the three-way guard above failed), prefer the LEFT seam — consistent with
  // the three-way survivor choice — and drop the right so the incompatible
  // right list stays separate with its own style.
  if (singleBlock && leftMergeable && rightMergeable) {
    rightMergeable = false;
  }

  // Otherwise the two seams are independent. Process the RIGHT seam FIRST so its
  // deletion at the higher indices cannot shift the left seam's [i-1, i].
  if (rightMergeable) {
    // Survivor is the pre-existing right neighbour; PREPEND the inserted items.
    right.content.unshift(...boundaryRight.content);
    parent.splice(j - 1, 1);
  }
  if (leftMergeable) {
    // Survivor is the pre-existing left neighbour; APPEND the inserted items.
    left.content.push(...boundaryLeft.content);
    parent.splice(i, 1);
  }
}

/** Options controlling where `insertNodeRelative` places the new node. */
export interface InsertOptions {
  position: "before" | "after" | "append";
  /** Resolve the anchor by node id anywhere in the tree (preferred). */
  anchorNodeId?: string;
  /** Fallback: first TOP-LEVEL block whose plain text includes this string. */
  anchorText?: string;
}

/**
 * Insert a deep clone of `node` relative to an anchor.
 *
 * - position "append": push the node onto the top-level `doc.content`.
 * - position "before"/"after": locate the anchor and splice the node into the
 *   anchor's parent `content` array immediately before / after it.
 *
 * Anchor resolution for before/after:
 *   - if `anchorNodeId` is given, find the node with `attrs.id === anchorNodeId`
 *     anywhere in the tree (recursive);
 *   - otherwise, if `anchorText` is given, scan only TOP-LEVEL `doc.content`
 *     blocks and pick the first whose `blockPlainText` includes `anchorText`.
 *
 * Operates on a clone of `doc`; returns `{ doc, inserted }`. `inserted` is
 * false when the anchor could not be resolved (the doc is returned unchanged
 * apart from being cloned).
 */
export function insertNodeRelative(
  doc: any,
  node: any,
  opts: InsertOptions,
): { doc: any; inserted: boolean } {
  const out = clone(doc);
  const fresh = clone(node);

  // Defensive: stay null-safe like the other exports — a missing opts means
  // there is nothing actionable to do.
  if (!isObject(opts)) return { doc: out, inserted: false };

  const isStructural = isObject(node) && STRUCTURAL_TYPES.has(node.type);

  // "append": top-level push.
  if (opts.position === "append") {
    // Structural table nodes (tableRow/tableCell/tableHeader) cannot live at the
    // top level — appending one would produce invalid nesting.
    if (isStructural) {
      throw new Error(
        `insertNode: cannot append a ${node.type} at the top level; use ` +
          `position before/after with an anchor inside the target table`,
      );
    }
    if (isObject(out)) {
      if (!Array.isArray(out.content)) out.content = [];
      const at = out.content.length;
      out.content.push(fresh);
      // Coalesce the left seam with the prior tail block (#535).
      coalesceSeams(out.content, at, out.content.length);
      return { doc: out, inserted: true };
    }
    return { doc: out, inserted: false };
  }

  const offset = opts.position === "after" ? 1 : 0;

  // Structural insert (before/after a tableRow/tableCell/tableHeader): splice
  // into the nearest enclosing table/tableRow rather than the anchor's direct
  // parent, so the row/cell lands at the correct level of the table.
  if (isStructural) {
    const containerType = REQUIRED_CONTAINER[node.type];
    const chain = findAnchorChain(out, opts);
    // Anchor not resolved at all — keep the existing "anchor not found" path.
    if (chain == null) return { doc: out, inserted: false };

    // Find the DEEPEST ancestor (including the anchor itself) of the required
    // container type.
    let containerIdx = -1;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (isObject(chain[i].node) && chain[i].node.type === containerType) {
        containerIdx = i;
        break;
      }
    }

    if (containerIdx === -1) {
      throw new Error(
        `insertNode: cannot insert a ${node.type} here — the anchor is not ` +
          `inside a ${containerType}. Anchor on a cell's text or a block id ` +
          `that lives inside the target table.`,
      );
    }

    const container = chain[containerIdx].node;
    if (!Array.isArray(container.content)) container.content = [];

    if (containerIdx === chain.length - 1) {
      // The matched container IS the anchor node itself (e.g. anchorText
      // resolved to the table block): append/prepend within it.
      const at = opts.position === "after" ? container.content.length : 0;
      container.content.splice(at, 0, fresh);
    } else {
      // The immediate child on the path leading to the anchor is the row/cell
      // to splice next to.
      const enclosingChildIndex = chain[containerIdx + 1].index;
      container.content.splice(enclosingChildIndex + offset, 0, fresh);
    }
    return { doc: out, inserted: true };
  }

  // before/after (non-structural): resolve the anchor's ancestor chain and
  // splice into the anchor's IMMEDIATE parent, so seam coalescing runs against
  // the ACTUAL parent array (also correctly handling a list nested in a callout
  // / table cell). The first-match / top-level-only semantics of anchorNodeId /
  // anchorText are preserved by findAnchorChain (identical to the old walk).
  const chain = findAnchorChain(out, opts);
  if (chain == null || chain.length < 2) return { doc: out, inserted: false };
  const parent = chain[chain.length - 2].node.content;
  if (!Array.isArray(parent)) return { doc: out, inserted: false };
  const at = chain[chain.length - 1].index + offset;
  parent.splice(at, 0, fresh);
  coalesceSeams(parent, at, at + 1);
  return { doc: out, inserted: true };
}

/**
 * Insert an ORDERED ARRAY of nodes relative to an anchor, preserving their
 * order. This is the multi-node twin of `insertNodeRelative`, used by the
 * markdown insert path where importing a markdown fragment can yield several
 * blocks that must land, in order, at one anchor.
 *
 * Semantics mirror `insertNodeRelative` exactly:
 *  - position "append": push every node onto the top-level `doc.content`.
 *  - position "before"/"after": splice every node into the anchor\'s parent
 *    `content` array immediately before / after it, keeping array order.
 *
 * The structural-table branch of `insertNodeRelative` is intentionally NOT
 * duplicated here: a markdown fragment can never produce a bare tableRow/
 * tableCell/tableHeader (those are not expressible in markdown), so the markdown
 * insert path only ever hands whole top-level blocks. Structural inserts stay on
 * the single-node JSON path. An empty `nodes` array is a no-op that still
 * reports `inserted:false` (nothing to place).
 *
 * Operates on a clone of `doc`; returns `{ doc, inserted }`. `inserted` is false
 * when the anchor could not be resolved (doc returned unchanged apart from the
 * clone) or when `nodes` is empty.
 */
export function insertNodesRelative(
  doc: any,
  nodes: any[],
  opts: InsertOptions,
): { doc: any; inserted: boolean } {
  const out = clone(doc);
  const fresh = Array.isArray(nodes) ? nodes.map((n) => clone(n)) : [];

  if (!isObject(opts) || fresh.length === 0) {
    return { doc: out, inserted: false };
  }

  // "append": push every node at the top level, in order.
  if (opts.position === "append") {
    if (isObject(out)) {
      if (!Array.isArray(out.content)) out.content = [];
      const at = out.content.length;
      out.content.push(...fresh);
      // Coalesce the left seam with the prior tail block; the run's right side
      // has no neighbour at the top level (#535).
      coalesceSeams(out.content, at, out.content.length);
      return { doc: out, inserted: true };
    }
    return { doc: out, inserted: false };
  }

  const offset = opts.position === "after" ? 1 : 0;

  // before/after: resolve the anchor's ancestor chain and splice the whole run
  // into the anchor's IMMEDIATE parent, then coalesce ONLY the run's two
  // boundary seams (inner blocks are untouched). Converting to findAnchorChain
  // makes coalescing run against the ACTUAL parent array (incl. lists nested in
  // callouts / table cells); first-match / top-level-only semantics preserved.
  const chain = findAnchorChain(out, opts);
  if (chain == null || chain.length < 2) return { doc: out, inserted: false };
  const parent = chain[chain.length - 2].node.content;
  if (!Array.isArray(parent)) return { doc: out, inserted: false };
  const at = chain[chain.length - 1].index + offset;
  parent.splice(at, 0, ...fresh);
  coalesceSeams(parent, at, at + fresh.length);
  return { doc: out, inserted: true };
}

// ===========================================================================
// Table editing helpers
//
// A Docmost table is a ProseMirror subtree with NO ids on the structural nodes:
//   table   -> { type:"table",     content:[tableRow...] }
//   row     -> { type:"tableRow",  content:[tableCell|tableHeader...] }
//   cell    -> { type:"tableCell"|"tableHeader", attrs:{colspan,rowspan,colwidth},
//                content:[paragraph...] }
//   para    -> { type:"paragraph", attrs:{id,indent}, content:[textNode...] }
// Only paragraphs/headings carry an `attrs.id`, so a cell is addressed via the
// id of the paragraph inside it. The helpers below all operate on a DEEP CLONE
// of the input doc (via `clone`) and never mutate their inputs.
// ===========================================================================

/**
 * Collect EVERY `attrs.id` present anywhere in `node` into `used`. Used to seed
 * `makeFreshId` so generated paragraph ids never collide with existing ones.
 */
function collectIds(node: any, used: Set<string>): void {
  if (!isObject(node)) return;
  if (isObject(node.attrs) && typeof node.attrs.id === "string") {
    used.add(node.attrs.id);
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) collectIds(child, used);
  }
}

/**
 * Fresh-id generator: returns a random Docmost-style id (12 chars from
 * lowercase `a-z0-9`) that is not already in `used`, and records it. On the
 * rare collision the id is regenerated. Callers rely on uniqueness, not on the
 * exact string, so randomness is fine — and unlike a module-local counter it
 * needs no reset and cannot become predictable across calls.
 */
function makeFreshId(used: Set<string>): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id: string;
  do {
    id = "";
    for (let i = 0; i < 12; i++) {
      id += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
  } while (used.has(id) || id === "");
  used.add(id);
  return id;
}

/**
 * Re-mint any top-level block id in `blocks` that already exists in `liveDoc`,
 * so a 1 -> N splice cannot introduce a duplicate id. `skipIndex` (optional) is a
 * block whose id is intentionally set (the patch path's first block inherits the
 * target node's id) and must not be re-minted. Mutates `blocks` in place.
 */
export function reassignCollidingBlockIds(
  liveDoc: any,
  blocks: any[],
  skipIndex?: number,
): void {
  const used = new Set<string>();
  collectIds(liveDoc, used);
  blocks.forEach((b, i) => {
    if (i === skipIndex || !isObject(b)) return;
    if (!isObject(b.attrs)) b.attrs = {};
    if (b.attrs.id != null && used.has(b.attrs.id)) b.attrs.id = makeFreshId(used);
    if (b.attrs.id != null) used.add(b.attrs.id);
  });
}

/**
 * Resolve a table reference against an ALREADY-CLONED doc and return the LIVE
 * table node (a reference inside `rootClone`, so the caller may mutate it) plus
 * its index path. Returns null when no table matches.
 *
 * - `#<n>`: the top-level block at index `n`, only if its `type === "table"`.
 * - otherwise: DFS for the node with `attrs.id === tableRef`, then walk UP its
 *   ancestor chain to the nearest `type === "table"` ancestor.
 */
function locateTable(
  rootClone: any,
  tableRef: string,
): { table: any; path: number[] } | null {
  if (!isObject(rootClone)) return null;

  // "#<n>": index into the top-level content array; must be a table.
  const indexMatch =
    typeof tableRef === "string" ? tableRef.match(/^#(\d+)$/) : null;
  if (indexMatch) {
    const index = Number(indexMatch[1]);
    const block = Array.isArray(rootClone.content)
      ? rootClone.content[index]
      : undefined;
    if (isObject(block) && block.type === "table") {
      return { table: block, path: [index] };
    }
    return null;
  }

  // Otherwise: DFS for attrs.id === tableRef, tracking the ancestor chain, then
  // climb to the nearest enclosing table.
  const search = (
    node: any,
    trail: { node: any; index: number }[],
  ): { table: any; path: number[] } | null => {
    if (!isObject(node)) return null;
    if (Array.isArray(node.content)) {
      for (let i = 0; i < node.content.length; i++) {
        const child = node.content[i];
        const here = [...trail, { node: child, index: i }];
        if (matchesId(child, tableRef)) {
          // Walk UP to the nearest table ancestor (including the match itself).
          for (let j = here.length - 1; j >= 0; j--) {
            if (isObject(here[j].node) && here[j].node.type === "table") {
              return {
                table: here[j].node,
                path: here.slice(0, j + 1).map((e) => e.index),
              };
            }
          }
          return null; // id found but no enclosing table
        }
        const hit = search(child, here);
        if (hit != null) return hit;
      }
    }
    return null;
  };

  return search(rootClone, []);
}

/** Build the plain-text → single-paragraph cell content used by all writers. */
function makeCellParagraph(id: string, text: string): any {
  return {
    type: "paragraph",
    attrs: { id, indent: 0 },
    // Empty string → a paragraph with an empty content array.
    content: text ? [{ type: "text", text }] : [],
  };
}

/**
 * Read a table as a matrix. Returns null when `tableRef` resolves to no table.
 *
 * - `rows`/`cols`: the table's row count and the column count of its FIRST row.
 *   Tables may be ragged (rows of differing length), so `cols` reflects only
 *   row 0; use the per-row length of `cells`/`cellIds` for each row's actual
 *   width.
 * - `cells`: `string[][]` of each cell's `blockPlainText`.
 * - `cellIds`: `(string|null)[][]` of each cell's FIRST paragraph id (or null),
 *   so callers can `patchNode` a cell for rich-formatted edits.
 * - `path`: index path of the table within the doc.
 */
export function readTable(
  doc: any,
  tableRef: string,
): {
  rows: number;
  cols: number;
  cells: string[][];
  cellIds: (string | null)[][];
  path: number[];
} | null {
  const root = clone(doc);
  const located = locateTable(root, tableRef);
  if (located == null) return null;
  const { table, path } = located;

  const rowNodes = Array.isArray(table.content) ? table.content : [];
  const rows = rowNodes.length;
  const cols = rowNodes[0]?.content?.length ?? 0;

  const cells: string[][] = [];
  const cellIds: (string | null)[][] = [];
  for (const rowNode of rowNodes) {
    const cellNodes = Array.isArray(rowNode?.content) ? rowNode.content : [];
    const rowText: string[] = [];
    const rowIds: (string | null)[] = [];
    for (const cellNode of cellNodes) {
      rowText.push(blockPlainText(cellNode));
      // The cell's first paragraph carries the id used for patchNode.
      const firstPara = Array.isArray(cellNode?.content)
        ? cellNode.content[0]
        : undefined;
      const id =
        isObject(firstPara) && isObject(firstPara.attrs)
          ? (firstPara.attrs.id ?? null)
          : null;
      rowIds.push(id);
    }
    cells.push(rowText);
    cellIds.push(rowIds);
  }

  return { rows, cols, cells, cellIds, path };
}

/**
 * Insert a row of plain-text cells into a table. Returns `{ doc, inserted }`.
 *
 * The row is padded to the table's column count (`cells[i] ?? ""`); supplying
 * MORE cells than columns throws. Each new cell copies `colwidth` for its
 * column from the header row when present, gets a fresh-id paragraph, and a
 * `colspan:1, rowspan:1` attrs. `index` (when an integer in `[0, rows]`) splices
 * the row there; otherwise the row is appended at the end.
 */
export function insertTableRow(
  doc: any,
  tableRef: string,
  cells: string[],
  index?: number,
): { doc: any; inserted: boolean } {
  const out = clone(doc);
  const located = locateTable(out, tableRef);
  if (located == null) return { doc: out, inserted: false };
  const { table } = located;

  if (!Array.isArray(table.content)) table.content = [];
  const rows = table.content.length;
  const headerRow = table.content[0];
  const headerCells = Array.isArray(headerRow?.content)
    ? headerRow.content
    : [];

  // Column count is the WIDEST existing row, so the guard below stays
  // meaningful for ragged tables and the new row matches the table's width.
  // Fall back to the supplied cell count only when the table has no rows.
  let colCount = 0;
  for (const r of table.content) {
    if (isObject(r) && Array.isArray(r.content))
      colCount = Math.max(colCount, r.content.length);
  }
  if (colCount === 0) colCount = Array.isArray(cells) ? cells.length : 0;

  if (Array.isArray(cells) && cells.length > colCount) {
    throw new Error(
      `tableInsertRow: got ${cells.length} cell(s) but the table has ${colCount} column(s)`,
    );
  }

  // Resolve the landing index up front so the cell-type decision and the splice
  // below agree: a valid integer in [0, rows] splices there, else we append.
  const landingIndex =
    typeof index === "number" &&
    Number.isInteger(index) &&
    index >= 0 &&
    index <= rows
      ? index
      : rows;

  // Seed the id generator with every id already in the doc so the new cell
  // paragraph ids are unique within the whole document.
  const used = new Set<string>();
  collectIds(out, used);

  const newCells: any[] = [];
  for (let i = 0; i < colCount; i++) {
    const text = (Array.isArray(cells) ? cells[i] : undefined) ?? "";
    const attrs: Record<string, any> = { colspan: 1, rowspan: 1 };
    // Copy this column's colwidth from the header row's cell when present.
    const colwidth = headerCells[i]?.attrs?.colwidth;
    if (colwidth !== undefined) attrs.colwidth = colwidth;
    // A row landing at index 0 becomes the new header row, so inherit the
    // current header cell's type per column (Docmost uses "tableHeader" there);
    // every other position is a plain data cell.
    const cellType =
      landingIndex === 0 ? (headerCells[i]?.type ?? "tableCell") : "tableCell";
    newCells.push({
      type: cellType,
      attrs,
      content: [makeCellParagraph(makeFreshId(used), text)],
    });
  }

  const newRow = { type: "tableRow", content: newCells };

  // Splice at the resolved landing index (append when index was omitted/invalid).
  table.content.splice(landingIndex, 0, newRow);

  return { doc: out, inserted: true };
}

/**
 * Delete the row at 0-based `index` from a table. Returns `{ doc, deleted }`.
 * `deleted` is false only when the table cannot be located. Throws on an
 * out-of-range index, and refuses to delete the table's only row.
 */
export function deleteTableRow(
  doc: any,
  tableRef: string,
  index: number,
): { doc: any; deleted: boolean } {
  const out = clone(doc);
  const located = locateTable(out, tableRef);
  if (located == null) return { doc: out, deleted: false };
  const { table } = located;

  if (!Array.isArray(table.content)) table.content = [];
  const rows = table.content.length;

  if (!Number.isInteger(index) || index < 0 || index >= rows) {
    throw new Error(
      `tableDeleteRow: row index ${index} out of range (table has ${rows} row(s))`,
    );
  }
  if (rows <= 1) {
    throw new Error(
      "tableDeleteRow: refusing to delete the only row of the table",
    );
  }

  table.content.splice(index, 1);
  return { doc: out, deleted: true };
}

/**
 * Set the plain-text content of cell `[row, col]` (0-based) to `text`. Returns
 * `{ doc, updated }`; `updated` is false only when the table cannot be located.
 * Throws when `row`/`col` is out of range. The cell's own attrs (colspan/
 * rowspan/colwidth) are preserved; its content becomes a single text paragraph
 * that reuses the cell's existing first-paragraph id when present, else a fresh
 * one.
 */
export function updateTableCell(
  doc: any,
  tableRef: string,
  row: number,
  col: number,
  text: string,
): { doc: any; updated: boolean } {
  const out = clone(doc);
  const located = locateTable(out, tableRef);
  if (located == null) return { doc: out, updated: false };
  const { table } = located;

  const rowNodes = Array.isArray(table.content) ? table.content : [];
  const rows = rowNodes.length;
  const rowNode = rowNodes[row];
  const cols =
    isObject(rowNode) && Array.isArray(rowNode.content)
      ? rowNode.content.length
      : 0;

  if (
    !Number.isInteger(row) ||
    row < 0 ||
    row >= rows ||
    !Number.isInteger(col) ||
    col < 0 ||
    col >= cols
  ) {
    throw new Error(`tableUpdateCell: cell [${row},${col}] out of range`);
  }

  const cellNode = rowNode.content[col];
  // Reuse the cell's existing first-paragraph id, or mint a fresh unique one.
  const existingPara = Array.isArray(cellNode?.content)
    ? cellNode.content[0]
    : undefined;
  let id =
    isObject(existingPara) && isObject(existingPara.attrs)
      ? existingPara.attrs.id
      : undefined;
  if (typeof id !== "string" || id.length === 0) {
    const used = new Set<string>();
    collectIds(out, used);
    id = makeFreshId(used);
  }

  cellNode.content = [makeCellParagraph(id, text)];
  return { doc: out, updated: true };
}
