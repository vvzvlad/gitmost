/**
 * Headless, Docmost-equivalent document diff.
 *
 * Docmost's history editor computes a change set with the exact pipeline below
 * (recreateTransform -> ChangeSet.addSteps -> simplifyChanges) and renders it as
 * editor decorations. This module runs the SAME computation but serializes the
 * result to text + integrity counts instead of decorations, so a diff can be
 * previewed without a browser.
 *
 * recreateTransform here comes from @docmost/editor-ext (issue #582) — the SAME
 * implementation the in-app history diff renders with, so the MCP verify report
 * and the UI can never disagree about what changed. It exposes the usual
 * recreateTransform(fromDoc, toDoc, { complexSteps, wordDiffs, simplifyDiff })
 * signature. (It used to come from a published fork of the same library, whose
 * array diff was quadratic; #581 replaced that with a linear fastCreatePatch in
 * editor-ext and capped the per-node word-diff bomb at its root.)
 *
 * If recreateTransform / the changeset throws on a pathological document pair,
 * OR the pair is too large to diff cheaply (see the size guard below), we fall
 * back to a coarse block-level text diff so the tool never hard-fails and never
 * pins the event loop.
 *
 * SIZE GUARD (issue #464 — prod CPU-DoS). The diff pipeline is synchronous and
 * super-linear in the size of the pair; a large/heavily-changed doc used to run
 * for seconds-to-hours and starve the whole process (BullMQ, Redis lock
 * renewals, embeddings). It never THROWS — it just never finishes — so the
 * try/catch below cannot save us. Because diffDocs runs on EVERY in-app/MCP
 * content edit's verify report, we PRE-FLIGHT the doc size and route anything
 * above a measured cap straight to the coarse fallback (the same shape the catch
 * produces). Same cap+fallback pattern as the ELK-layout DoS fix (#440 /
 * c917dcc3). The guard STAYS after #581/#582: the algorithm is 1.5-5x faster, so the
 * NODE cap moved up (150 -> 200), but the BYTE cap moved DOWN (12 KiB -> 4 KiB),
 * because the byte-heavy worst case lives OUTSIDE the algorithm #581 fixed (in
 * ChangeSet.addSteps) and 12 KiB was admitting 300-660ms blocks while advertising a
 * ~200ms budget. Net: this SHRINKS the precise-diff envelope. Both caps are measured
 * against inputs the guard actually ADMITS — see below.
 */

import { Node } from "@tiptap/pm/model";
import { ChangeSet, simplifyChanges } from "@tiptap/pm/changeset";
// SUBPATH import, deliberately NOT the "@docmost/editor-ext" barrel. The barrel
// re-exports the whole editor extension set, which drags @tiptap/react ->
// prosemirror-view -> React + react-dom into this dependency-light EXTERNAL MCP
// server: measured 216 modules (incl. prosemirror-view, react, react-dom) vs 38 via
// the subpath (whose only external requires are @tiptap/pm/*, diff, rfc6902).
//
// It is not merely heavy — the barrel CRASHES this server on Node < 21. collaboration.ts
// sets `global.document` from JSDOM but deliberately leaves `global.navigator` unset;
// prosemirror-view's CJS module top-level then computes `webkit` from `document` and,
// when it is truthy, reads a BARE `navigator.userAgent` (dist/index.cjs:174, unguarded
// unlike the `nav` reads above it) -> `ReferenceError: navigator is not defined`. Node
// >= 21 happens to define a global `navigator`, which is the only reason this ever
// looked fine. Whether it fired depended purely on import ORDER, and it DID fire: the
// mcp unit suite was red on Node 20 (collab-session + save-page-version) before this
// switch. The subpath pulls the SAME recreateTransform and never loads prosemirror-view.
import { recreateTransform } from "@docmost/editor-ext/dist/lib/recreate-transform/index.js";
import { docmostSchema } from "./docmost-schema.js";

/** A single inserted/deleted change with its containing-block context. */
export interface DiffChange {
  op: "insert" | "delete";
  /** Lead (plain) text of the block that contains the change, for context. */
  block: string;
  /** The inserted or deleted text. */
  text: string;
}

/** Integrity counts as [old, new] tuples; footnoteMarkers as [oldList, newList]. */
export interface DiffIntegrity {
  images: [number, number];
  links: [number, number];
  tables: [number, number];
  callouts: [number, number];
  codeBlocks: [number, number];
  /**
   * Diagram block atoms (#600). Both are atoms whose ENTIRE payload lives in
   * attrs (src/attachmentId), so deleting one moves no prose and no marks — the
   * only trace in the text delta is the single leaf placeholder `textBetween`
   * emits for an atom, i.e. a 1-char delta indistinguishable from fixing a typo.
   * The count is what NAMES the loss (attribution), which is the blind spot
   * codeBlocks closed for code.
   *
   * Counted as TWO keys, not one "diagrams" bucket: a bucket would report a
   * drawio replaced by an excalidraw as `1 -> 1` (clean) and omit it from
   * `VerifyReport.structure` entirely — recreating the very blind spot this
   * guard exists to close.
   */
  drawio: [number, number];
  excalidraw: [number, number];
  /**
   * Block-atom DATA CARRIERS (#619). Same blind zone as the diagram atoms above:
   * each is a top-level block whose ENTIRE payload lives in `attrs`
   * (src/attachmentId/sourcePageId/…), so deleting one moves no prose and no
   * marks — the only trace in the text delta is the single leaf placeholder
   * `textBetween` emits for an atom, a 1-char change indistinguishable from a
   * typo fix. The count is what NAMES the loss (attribution), which is the blind
   * spot codeBlocks/drawio closed for their kinds.
   *
   * Counted as SEPARATE keys, never one "media"/"embeds" bucket: a bucket would
   * report e.g. a video replaced by an audio as `1 -> 1` (clean) and omit it
   * from `VerifyReport.structure` entirely — recreating the very blind spot this
   * guard exists to close. `youtube` is a distinct node type from `embed` in the
   * runtime schema, so both are counted. (Inline atoms mathInline/mention are
   * out of scope — this guard is for block-atom data carriers.)
   */
  attachment: [number, number];
  video: [number, number];
  audio: [number, number];
  pdf: [number, number];
  embed: [number, number];
  youtube: [number, number];
  htmlEmbed: [number, number];
  mathBlock: [number, number];
  pageEmbed: [number, number];
  subpages: [number, number];
  transclusionSource: [number, number];
  transclusionReference: [number, number];
  footnoteMarkers: [number[], number[]];
}

export interface DiffResult {
  summary: { inserted: number; deleted: number; blocksChanged: number };
  integrity: DiffIntegrity;
  changes: DiffChange[];
  /** Human-readable unified-ish summary. */
  markdown: string;
}


/** Recursively concatenate the plain text of a JSON node. */
function plainText(node: any): string {
  if (!node || typeof node !== "object") return "";
  let out = "";
  if (typeof node.text === "string") out += node.text;
  if (Array.isArray(node.content)) {
    for (const child of node.content) out += plainText(child);
  }
  return out;
}

/** Count nodes in a JSON doc that satisfy `pred` (recursive). */
function countNodes(doc: any, pred: (node: any) => boolean): number {
  let n = 0;
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (pred(node)) n++;
    if (Array.isArray(node.content)) for (const c of node.content) visit(c);
  };
  visit(doc);
  return n;
}

// --- Issue #464/#465/#582: pre-flight size guard for the precise diff ---------
// Defaults are BENCHMARK-derived (scripts/diff-size-guard-bench.mjs) on the
// CURRENT pipeline — editor-ext's recreateTransform (complexSteps:false,
// wordDiffs:true, simplifyDiff:true) + ChangeSet.addSteps + simplifyChanges —
// with the same goal as #465: keep the WORST ADMITTED case's synchronous block
// inside the ~200ms budget. "Admitted" is the load-bearing word: a cap may only be
// justified by inputs the guard actually LETS THROUGH. (#582 originally calibrated
// the node axis on corner docs of 13-15 KB — above the byte cap, i.e. docs the
// guard REFUSES — so those numbers justified nothing. The generator now
// binary-searches the text length so a corner doc lands JUST UNDER the byte cap.)
//
//   BYTE AXIS — TIGHTENED, 12 KiB -> 4 KiB. This is the axis that actually binds,
//   and the old cap did NOT hold the budget it advertised. The byte-heavy worst case
//   is a large text node REWRITTEN wholesale. Its cost is NOT in the diff —
//   editor-ext's #581 word-diff caps bound that (recreateTransform is a few ms here)
//   — but in ChangeSet.addSteps, which re-diffs the replaced range internally and
//   which #581 did NOT touch. Splitting the two stages on one rewritten text node
//   makes that plain: at 6 KB recreateTransform is 17ms vs addSteps 194ms; at 12 KB
//   it is 0.7ms vs addSteps 362ms. So the old 12 KiB cap was ADMITTING blocks of
//   300-660ms all along (seconds before #581) while claiming a ~200ms budget.
//   Tightening it is a DoS FIX, not a feature regression.
//
//   The adversary picks the TOKEN DENSITY, not just the byte count: addSteps works
//   token-by-token, so the same bytes made of short unique tokens (base36 counters)
//   cost ~40-60% more than prose-length words. The cap must survive that shape,
//   because the document is agent/user-authored. Worst ADMITTED-vs-refused times,
//   all text rewritten (best-of-3, dev box; "dense" = shortest unique tokens):
//     bytes  | 1 text node | dense 1n | dense 2n | dense 3n | verdict
//      4 KiB |   156 ms    |  136 ms  |  110 ms  |   72 ms  | ADMIT — budget holds
//      5 KiB |     —       |  170 ms  |  163 ms  |  136 ms  | refuse
//      6 KiB |   234 ms    |  202 ms  |  195 ms  |  174 ms  | refuse (over budget)
//      8 KiB |   345 ms    |  264 ms  |  268 ms  |  250 ms  | refuse
//     12 KiB |   449 ms    |  435 ms  |  437 ms  |  402 ms  | refuse (the OLD cap)
//   4 KiB is therefore the largest cap under which EVERY admitted shape stays inside
//   ~200ms. Operators who want precise diffs on byte-heavy docs and accept the block
//   can opt in: MCP_DIFF_MAX_BYTES=6144 (~200-235ms) or =12288 (~400-660ms, the old
//   behaviour). The aggregate word-diff shape (many ~2 KB nodes, half edited) is
//   cheap by comparison (125 KB / 129 nodes -> 96 ms) and is NOT what binds here.
//
//   NODE AXIS — 200 (was 150), and under the default byte cap it is SUBSUMED: it can
//   never trip. Even the cheapest possible node (an empty paragraph, ~21 B of JSON)
//   only gets ~190 nodes into 4 KiB, and a doc of TEXT blocks (~55 B each) tops out
//   at ~68 blocks / ~137 nodes — so the byte cap always refuses first. Corner docs
//   sized to land just under the byte cap, every block rewritten:
//     nodes | bytes | time
//        61 |  4076 |  26 ms
//       101 |  4076 |  43 ms
//       121 |  4046 |  50 ms
//       137+|   —   | unreachable (cannot fit under the byte cap)
//   The node cap is kept as defence-in-depth and stays MEANINGFUL for operators who
//   RAISE MCP_DIFF_MAX_BYTES: in that regime the corner docs become reachable again
//   and 200 is where the budget lands (at a 6 KiB byte budget: 151 nodes -> 78 ms,
//   201 nodes -> 116 ms; at 12 KiB: 227 nodes -> 185 ms, 251 -> 227 ms). It also
//   still bounds byte-cheap/node-heavy shapes (deep nesting) if the byte cap is
//   raised. NOTE the consequence: #582 does NOT enlarge the precise-diff envelope —
//   it SHRINKS it. The 150->200 node raise admits nothing new for prose, because the
//   byte cap refuses those docs first.
//
// Either metric over its cap routes to the coarse fallback. Both are env-tunable
// for operators who accept more CPU in exchange for exact diffs on larger docs.
const DEFAULT_MAX_NODES = 200;
const DEFAULT_MAX_BYTES = 4 * 1024;

/**
 * Read a positive-integer env override, falling back to `dflt`. Garbage / unset /
 * non-finite / non-positive all fall back (so the guard can never be accidentally
 * disabled by a malformed value). Read fresh on every call so a test / operator
 * can flip the knob without a restart.
 */
function readPositiveIntEnv(name: string, dflt: number): number {
  const raw = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : dflt;
}

/**
 * True when the pair is too large for the precise (recreateTransform) diff and
 * must degrade to the coarse fallback. Takes the MAX of the two docs on each
 * metric so an ASYMMETRIC pair (a small new doc vs a huge old doc, or vice
 * versa) — whose diff cost is driven by the BIG side — is caught. Cheap: one
 * node walk + one JSON.stringify per doc, both O(size).
 */
function exceedsDiffSizeGuard(oldDoc: any, newDoc: any): boolean {
  const maxNodes = readPositiveIntEnv("MCP_DIFF_MAX_NODES", DEFAULT_MAX_NODES);
  const maxBytes = readPositiveIntEnv("MCP_DIFF_MAX_BYTES", DEFAULT_MAX_BYTES);
  const nodes = Math.max(
    countNodes(oldDoc, () => true),
    countNodes(newDoc, () => true),
  );
  if (nodes > maxNodes) return true;
  const bytes = Math.max(
    JSON.stringify(oldDoc)?.length ?? 0,
    JSON.stringify(newDoc)?.length ?? 0,
  );
  return bytes > maxBytes;
}

/**
 * Count UNIQUE links in a JSON doc by their `href`. A single link can be split
 * across several adjacent text runs (e.g. a "link+bold" run followed by a "link"
 * run); counting link-bearing runs would over-count it. Walking the tree and
 * collecting hrefs into a Set keys each distinct link once. Link marks with a
 * missing/empty href are bucketed under a single "" key so a malformed link is
 * still counted as one.
 */
function countUniqueLinks(doc: any): number {
  const hrefs = new Set<string>();
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (node.type === "text" && Array.isArray(node.marks)) {
      for (const m of node.marks) {
        if (m && m.type === "link") {
          const href = m.attrs && typeof m.attrs.href === "string" ? m.attrs.href : "";
          hrefs.add(href);
        }
      }
    }
    if (Array.isArray(node.content)) for (const c of node.content) visit(c);
  };
  visit(doc);
  return hrefs.size;
}

/** Count footnoteReference nodes anywhere under a node (reading order). */
function countFootnoteRefs(node: any): number {
  if (!node || typeof node !== "object") return 0;
  let n = node.type === "footnoteReference" ? 1 : 0;
  if (Array.isArray(node.content)) {
    for (const child of node.content) n += countFootnoteRefs(child);
  }
  return n;
}

/**
 * Ordered list of footnote marker numbers found in the BODY only (every
 * top-level block before the first "Примечания..." notes heading; if no such
 * heading, the whole doc), in reading order.
 *
 * Supports BOTH representations:
 *  - real `footnoteReference` nodes (the current footnote feature) — numbered
 *    1..n by reading position, since their visible number is derived;
 *  - legacy `[N]` text markers (older translated docs) — the literal N.
 */
function footnoteMarkers(doc: any, notesHeading: string): number[] {
  const top: any[] = Array.isArray(doc?.content) ? doc.content : [];
  const notesIdx = top.findIndex(
    (n) =>
      n &&
      n.type === "heading" &&
      plainText(n).trim() === notesHeading,
  );
  const bodyBlocks = notesIdx >= 0 ? top.slice(0, notesIdx) : top;

  // Real footnoteReference nodes take precedence: when present, number them by
  // reading position (their displayed number is not stored).
  let refCount = 0;
  for (const block of bodyBlocks) refCount += countFootnoteRefs(block);
  if (refCount > 0) {
    return Array.from({ length: refCount }, (_, i) => i + 1);
  }

  // Fallback: legacy `[N]` text markers.
  const markers: number[] = [];
  const re = /\[(\d+)\]/g;
  for (const block of bodyBlocks) {
    const text = plainText(block);
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      markers.push(Number(m[1]));
    }
  }
  return markers;
}

/** Compute the [old,new] integrity tuples for two JSON docs. */
function computeIntegrity(
  oldDoc: any,
  newDoc: any,
  notesHeading: string,
): DiffIntegrity {
  const images: [number, number] = [
    countNodes(oldDoc, (n) => n.type === "image"),
    countNodes(newDoc, (n) => n.type === "image"),
  ];
  const links: [number, number] = [
    countUniqueLinks(oldDoc),
    countUniqueLinks(newDoc),
  ];
  const tables: [number, number] = [
    countNodes(oldDoc, (n) => n.type === "table"),
    countNodes(newDoc, (n) => n.type === "table"),
  ];
  const callouts: [number, number] = [
    countNodes(oldDoc, (n) => n.type === "callout"),
    countNodes(newDoc, (n) => n.type === "callout"),
  ];
  const codeBlocks: [number, number] = [
    countNodes(oldDoc, (n) => n.type === "codeBlock"),
    countNodes(newDoc, (n) => n.type === "codeBlock"),
  ];
  const drawio: [number, number] = [
    countNodes(oldDoc, (n) => n.type === "drawio"),
    countNodes(newDoc, (n) => n.type === "drawio"),
  ];
  const excalidraw: [number, number] = [
    countNodes(oldDoc, (n) => n.type === "excalidraw"),
    countNodes(newDoc, (n) => n.type === "excalidraw"),
  ];
  const attachment: [number, number] = [
    countNodes(oldDoc, (n) => n.type === "attachment"),
    countNodes(newDoc, (n) => n.type === "attachment"),
  ];
  const video: [number, number] = [
    countNodes(oldDoc, (n) => n.type === "video"),
    countNodes(newDoc, (n) => n.type === "video"),
  ];
  const audio: [number, number] = [
    countNodes(oldDoc, (n) => n.type === "audio"),
    countNodes(newDoc, (n) => n.type === "audio"),
  ];
  const pdf: [number, number] = [
    countNodes(oldDoc, (n) => n.type === "pdf"),
    countNodes(newDoc, (n) => n.type === "pdf"),
  ];
  const embed: [number, number] = [
    countNodes(oldDoc, (n) => n.type === "embed"),
    countNodes(newDoc, (n) => n.type === "embed"),
  ];
  const youtube: [number, number] = [
    countNodes(oldDoc, (n) => n.type === "youtube"),
    countNodes(newDoc, (n) => n.type === "youtube"),
  ];
  const htmlEmbed: [number, number] = [
    countNodes(oldDoc, (n) => n.type === "htmlEmbed"),
    countNodes(newDoc, (n) => n.type === "htmlEmbed"),
  ];
  const mathBlock: [number, number] = [
    countNodes(oldDoc, (n) => n.type === "mathBlock"),
    countNodes(newDoc, (n) => n.type === "mathBlock"),
  ];
  const pageEmbed: [number, number] = [
    countNodes(oldDoc, (n) => n.type === "pageEmbed"),
    countNodes(newDoc, (n) => n.type === "pageEmbed"),
  ];
  const subpages: [number, number] = [
    countNodes(oldDoc, (n) => n.type === "subpages"),
    countNodes(newDoc, (n) => n.type === "subpages"),
  ];
  const transclusionSource: [number, number] = [
    countNodes(oldDoc, (n) => n.type === "transclusionSource"),
    countNodes(newDoc, (n) => n.type === "transclusionSource"),
  ];
  const transclusionReference: [number, number] = [
    countNodes(oldDoc, (n) => n.type === "transclusionReference"),
    countNodes(newDoc, (n) => n.type === "transclusionReference"),
  ];
  const fns: [number[], number[]] = [
    footnoteMarkers(oldDoc, notesHeading),
    footnoteMarkers(newDoc, notesHeading),
  ];
  return {
    images,
    links,
    tables,
    callouts,
    codeBlocks,
    drawio,
    excalidraw,
    attachment,
    video,
    audio,
    pdf,
    embed,
    youtube,
    htmlEmbed,
    mathBlock,
    pageEmbed,
    subpages,
    transclusionSource,
    transclusionReference,
    footnoteMarkers: fns,
  };
}

/**
 * Resolve the lead text of the top-level block in a ProseMirror Node that
 * contains the given document position. Returns "" when out of range.
 */
function blockContextAt(node: Node, pos: number): string {
  try {
    const clamped = Math.max(0, Math.min(pos, node.content.size));
    const $pos = node.resolve(clamped);
    // depth 1 is the top-level block in a doc node.
    const block = $pos.depth >= 1 ? $pos.node(1) : $pos.node(0);
    const text = block.textContent || "";
    return text.length > 80 ? text.slice(0, 77) + "..." : text;
  } catch {
    return "";
  }
}

/** Truncate a string for the markdown summary. */
function truncate(s: string, n = 120): string {
  return s.length > n ? s.slice(0, n - 3) + "..." : s;
}

/**
 * Coarse fallback: a block-by-block plain-text diff. Used only when the precise
 * changeset pipeline throws, so the tool degrades gracefully instead of failing.
 */
function coarseDiff(oldDoc: any, newDoc: any): DiffChange[] {
  const oldBlocks: any[] = Array.isArray(oldDoc?.content) ? oldDoc.content : [];
  const newBlocks: any[] = Array.isArray(newDoc?.content) ? newDoc.content : [];
  const oldTexts = oldBlocks.map(plainText);
  const newTexts = newBlocks.map(plainText);
  const oldSet = new Set(oldTexts);
  const newSet = new Set(newTexts);
  const changes: DiffChange[] = [];
  for (const t of oldTexts) {
    if (!newSet.has(t) && t.trim() !== "") {
      changes.push({ op: "delete", block: truncate(t, 80), text: t });
    }
  }
  for (const t of newTexts) {
    if (!oldSet.has(t) && t.trim() !== "") {
      changes.push({ op: "insert", block: truncate(t, 80), text: t });
    }
  }
  return changes;
}

/** Accumulated textual changes plus their derived char/block tallies. */
interface DiffTally {
  changes: DiffChange[];
  inserted: number;
  deleted: number;
  changedBlocks: Set<string>;
}

/**
 * Produce the coarse-fallback tally for a pair. This is the SINGLE source of the
 * `fellBack:true` result shape, shared by BOTH degrade paths in diffDocs (the
 * pre-flight size guard and the recreateTransform catch) so they behave and
 * report identically.
 */
function coarseDiffTally(oldDoc: any, newDoc: any): DiffTally {
  const changes = coarseDiff(oldDoc, newDoc);
  let inserted = 0;
  let deleted = 0;
  const changedBlocks = new Set<string>();
  for (const c of changes) {
    if (c.op === "insert") inserted += c.text.length;
    else deleted += c.text.length;
    if (c.block) changedBlocks.add(c.op[0] + ":" + c.block);
  }
  return { changes, inserted, deleted, changedBlocks };
}

/**
 * Compute the PRECISE tally via the recreateTransform pipeline. Callers MUST
 * gate this behind the size guard (it can block the event loop for a large pair)
 * and wrap it in try/catch (a pathological pair can throw); on either the guard
 * or a throw, use `coarseDiffTally` instead. Kept as a sibling of
 * `coarseDiffTally` so both produce the same `DiffTally` shape.
 */
function preciseDiffTally(oldDocJson: any, newDocJson: any): DiffTally {
  const oldNode = Node.fromJSON(docmostSchema, oldDocJson);
  const newNode = Node.fromJSON(docmostSchema, newDocJson);
  const tr = recreateTransform(oldNode, newNode, {
    complexSteps: false,
    wordDiffs: true,
    simplifyDiff: true,
  });
  const changeSet = ChangeSet.create(oldNode).addSteps(tr.doc, tr.mapping.maps, []);
  const simplified = simplifyChanges(changeSet.changes, newNode);

  const changes: DiffChange[] = [];
  let inserted = 0;
  let deleted = 0;
  const changedBlocks = new Set<string>();

  for (const change of simplified) {
    // Deleted text lives in the OLD doc coordinate range [fromA, toA).
    if (change.toA > change.fromA) {
      const text = oldNode.textBetween(change.fromA, change.toA, "\n", " ");
      if (text.length > 0) {
        deleted += text.length;
        const block = blockContextAt(oldNode, change.fromA);
        changes.push({ op: "delete", block, text });
        if (block) changedBlocks.add("d:" + block);
      }
    }
    // Inserted text lives in the NEW doc coordinate range [fromB, toB).
    if (change.toB > change.fromB) {
      const text = newNode.textBetween(change.fromB, change.toB, "\n", " ");
      if (text.length > 0) {
        inserted += text.length;
        const block = blockContextAt(newNode, change.fromB);
        changes.push({ op: "insert", block, text });
        if (block) changedBlocks.add("i:" + block);
      }
    }
  }
  return { changes, inserted, deleted, changedBlocks };
}

/** Build the human-readable unified-ish markdown summary. */
function renderMarkdown(
  result: Omit<DiffResult, "markdown">,
  fellBack: boolean,
): string {
  const lines: string[] = [];
  const { summary, integrity, changes } = result;
  lines.push(
    `# Diff: ${summary.inserted} inserted / ${summary.deleted} deleted (${summary.blocksChanged} blocks changed)`,
  );
  if (fellBack) {
    lines.push("");
    lines.push("> note: precise diff failed; coarse block-level diff shown.");
  }
  lines.push("");
  lines.push("## Integrity (old -> new)");
  lines.push(`- images: ${integrity.images[0]} -> ${integrity.images[1]}`);
  lines.push(`- links: ${integrity.links[0]} -> ${integrity.links[1]}`);
  lines.push(`- tables: ${integrity.tables[0]} -> ${integrity.tables[1]}`);
  lines.push(`- callouts: ${integrity.callouts[0]} -> ${integrity.callouts[1]}`);
  lines.push(
    `- codeBlocks: ${integrity.codeBlocks[0]} -> ${integrity.codeBlocks[1]}`,
  );
  lines.push(
    `- drawio: ${integrity.drawio[0]} -> ${integrity.drawio[1]}`,
  );
  lines.push(
    `- excalidraw: ${integrity.excalidraw[0]} -> ${integrity.excalidraw[1]}`,
  );
  lines.push(
    `- attachment: ${integrity.attachment[0]} -> ${integrity.attachment[1]}`,
  );
  lines.push(`- video: ${integrity.video[0]} -> ${integrity.video[1]}`);
  lines.push(`- audio: ${integrity.audio[0]} -> ${integrity.audio[1]}`);
  lines.push(`- pdf: ${integrity.pdf[0]} -> ${integrity.pdf[1]}`);
  lines.push(`- embed: ${integrity.embed[0]} -> ${integrity.embed[1]}`);
  lines.push(`- youtube: ${integrity.youtube[0]} -> ${integrity.youtube[1]}`);
  lines.push(
    `- htmlEmbed: ${integrity.htmlEmbed[0]} -> ${integrity.htmlEmbed[1]}`,
  );
  lines.push(
    `- mathBlock: ${integrity.mathBlock[0]} -> ${integrity.mathBlock[1]}`,
  );
  lines.push(
    `- pageEmbed: ${integrity.pageEmbed[0]} -> ${integrity.pageEmbed[1]}`,
  );
  lines.push(
    `- subpages: ${integrity.subpages[0]} -> ${integrity.subpages[1]}`,
  );
  lines.push(
    `- transclusionSource: ${integrity.transclusionSource[0]} -> ${integrity.transclusionSource[1]}`,
  );
  lines.push(
    `- transclusionReference: ${integrity.transclusionReference[0]} -> ${integrity.transclusionReference[1]}`,
  );
  lines.push(
    `- footnoteMarkers: [${integrity.footnoteMarkers[0].join(", ")}] -> [${integrity.footnoteMarkers[1].join(", ")}]`,
  );
  lines.push("");
  lines.push("## Changes");
  if (changes.length === 0) {
    lines.push("(no textual changes)");
  } else {
    for (const c of changes) {
      const sign = c.op === "insert" ? "+" : "-";
      const ctx = c.block ? ` @ ${truncate(c.block, 60)}` : "";
      lines.push(`${sign} ${truncate(c.text)}${ctx}`);
    }
  }
  return lines.join("\n");
}

/**
 * Diff two ProseMirror JSON documents the way Docmost's history editor does and
 * serialize the result to text + integrity counts.
 *
 * @param oldDocJson the earlier document
 * @param newDocJson the later document
 * @param notesHeading heading delimiting body from notes for footnote counting
 */
export function diffDocs(
  oldDocJson: any,
  newDocJson: any,
  notesHeading: string = "Примечания переводчика",
): DiffResult {
  // computeIntegrity is cheap (linear node walks) and its counts are needed in
  // BOTH the precise and coarse paths, so it always runs first.
  const integrity = computeIntegrity(oldDocJson, newDocJson, notesHeading);

  let fellBack = false;
  let tally: DiffTally;

  // Pre-flight size guard (#464): a too-large pair would make recreateTransform
  // block the event loop for seconds-to-hours WITHOUT throwing, so route it to
  // the coarse fallback BEFORE calling recreateTransform at all. Both this path
  // and the catch below go through coarseDiffTally for an identical `fellBack`
  // result shape.
  if (exceedsDiffSizeGuard(oldDocJson, newDocJson)) {
    fellBack = true;
    tally = coarseDiffTally(oldDocJson, newDocJson);
  } else {
    try {
      tally = preciseDiffTally(oldDocJson, newDocJson);
    } catch {
      // Pathological pair: degrade to a coarse block-level diff so we never throw.
      fellBack = true;
      tally = coarseDiffTally(oldDocJson, newDocJson);
    }
  }

  const partial: Omit<DiffResult, "markdown"> = {
    summary: {
      inserted: tally.inserted,
      deleted: tally.deleted,
      blocksChanged: tally.changedBlocks.size,
    },
    integrity,
    changes: tally.changes,
  };
  return { ...partial, markdown: renderMarkdown(partial, fellBack) };
}

/**
 * Recursively walk every `text` node and tally the count of each mark by
 * `mark.type` (e.g. `{ bold: 5, strike: 3, link: 2 }`). Pure and never throws.
 */
function markCounts(doc: any): Record<string, number> {
  const counts: Record<string, number> = {};
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (node.type === "text" && Array.isArray(node.marks)) {
      for (const m of node.marks) {
        if (m && typeof m.type === "string") {
          counts[m.type] = (counts[m.type] || 0) + 1;
        }
      }
    }
    if (Array.isArray(node.content)) for (const c of node.content) visit(c);
  };
  visit(doc);
  return counts;
}

/**
 * A compact, machine-readable report of what actually changed between two
 * ProseMirror docs. Unlike DiffResult it ALSO surfaces a per-mark-type count
 * delta, because diffDocs diffs TEXT only (complexSteps:false) and so reports
 * 0/0 chars for a pure MARK change (e.g. removing `strike` from unchanged text).
 */
export interface VerifyReport {
  /** Did the document actually change at all. */
  changed: boolean;
  /** Chars inserted (from diffDocs). */
  textInserted: number;
  /** Chars deleted (from diffDocs). */
  textDeleted: number;
  blocksChanged: number;
  /** ONLY mark types whose count changed, as [before, after]. */
  marks: Record<string, [number, number]>;
  /**
   * ONLY structural integrity types whose count changed, as [before, after]
   * (images/links/tables/callouts/codeBlocks/drawio/excalidraw). Surfaces structural
   * mutations that touch neither text nor marks (e.g. insertImage, deleting a
   * table, a vanished code block or draw.io diagram) which diffDocs — being
   * TEXT-only — would otherwise report as "no content change".
   */
  structure?: Record<string, [number, number]>;
  /** One-line human/agent-readable summary. */
  summary: string;
}

/**
 * Build a VerifyReport for a content mutation. Pure and never throws — on any
 * internal error it returns a minimal "changed (diff unavailable)" report so it
 * can NEVER break a write.
 *
 * `changed` is VALUE-based, not JSON-string-based: it is derived from the actual
 * deltas (text chars, blocks, mark counts, structural integrity counts), so two
 * value-equal docs that differ only in JSON key order report cleanly as
 * `changed:false` / "no content change" rather than a misleading +0/-0 change.
 *
 * The structural integrity delta (from diffDocs's `integrity` tuples) is what
 * makes `changed` true for an image/table/callout/codeBlock/diagram/link count
 * change that diffs to zero text — closing a verify blind spot for insertImage,
 * deleteNode on a table, a vanished codeBlock or drawio/excalidraw diagram, etc.
 */
export function summarizeChange(before: any, after: any): VerifyReport {
  try {
    const diff = diffDocs(before, after);

    // Per-mark-type delta: include a type only when its count actually changed.
    const beforeMarks = markCounts(before);
    const afterMarks = markCounts(after);
    const marks: Record<string, [number, number]> = {};
    for (const type of new Set([
      ...Object.keys(beforeMarks),
      ...Object.keys(afterMarks),
    ])) {
      const b = beforeMarks[type] || 0;
      const a = afterMarks[type] || 0;
      if (b !== a) marks[type] = [b, a];
    }

    // Structural integrity delta from diffDocs: count-based [old,new] tuples for
    // images/links/tables/callouts/codeBlocks/drawio/excalidraw plus the #619
    // block-atom data carriers (attachment/video/audio/pdf/embed/youtube/
    // htmlEmbed/mathBlock/pageEmbed/subpages/transclusionSource/
    // transclusionReference). Include a type only when old != new.
    const integrity = diff.integrity;
    const structure: Record<string, [number, number]> = {};
    const countTypes: [
      "images",
      "links",
      "tables",
      "callouts",
      "codeBlocks",
      "drawio",
      "excalidraw",
      "attachment",
      "video",
      "audio",
      "pdf",
      "embed",
      "youtube",
      "htmlEmbed",
      "mathBlock",
      "pageEmbed",
      "subpages",
      "transclusionSource",
      "transclusionReference",
    ] = [
      "images",
      "links",
      "tables",
      "callouts",
      "codeBlocks",
      "drawio",
      "excalidraw",
      "attachment",
      "video",
      "audio",
      "pdf",
      "embed",
      "youtube",
      "htmlEmbed",
      "mathBlock",
      "pageEmbed",
      "subpages",
      "transclusionSource",
      "transclusionReference",
    ];
    for (const type of countTypes) {
      const [b, a] = integrity[type];
      if (b !== a) structure[type] = [b, a];
    }

    const textInserted = diff.summary.inserted;
    const textDeleted = diff.summary.deleted;
    const blocksChanged = diff.summary.blocksChanged;
    const hasMarkDelta = Object.keys(marks).length > 0;
    const hasStructureDelta = Object.keys(structure).length > 0;

    // VALUE-based change decision: ignore JSON key-order no-ops entirely.
    const changed =
      textInserted > 0 ||
      textDeleted > 0 ||
      blocksChanged > 0 ||
      hasMarkDelta ||
      hasStructureDelta;

    if (!changed) {
      return {
        changed: false,
        textInserted: 0,
        textDeleted: 0,
        blocksChanged: 0,
        marks: {},
        summary: "no content change",
      };
    }

    const parts: string[] = [];
    // Only mention text/blocks when they actually changed (avoid a misleading
    // "+0/-0 chars, 0 block(s)" prefix on a pure mark/structure change).
    if (textInserted > 0 || textDeleted > 0 || blocksChanged > 0) {
      parts.push(`+${textInserted}/-${textDeleted} chars, ${blocksChanged} block(s)`);
    }
    const markParts = Object.entries(marks).map(
      ([type, [b, a]]) => `${type} ${b}→${a}`,
    );
    if (markParts.length > 0) parts.push(`marks: ${markParts.join(", ")}`);
    const structureParts = Object.entries(structure).map(
      ([type, [b, a]]) => `${type} ${b}→${a}`,
    );
    if (structureParts.length > 0) parts.push(structureParts.join(", "));
    // `changed` is true here, so at least one group is present and parts is non-empty.
    const summary = `changed: ${parts.join("; ")}`;

    const report: VerifyReport = {
      changed: true,
      textInserted,
      textDeleted,
      blocksChanged,
      marks,
      summary,
    };
    if (hasStructureDelta) report.structure = structure;
    return report;
  } catch {
    // A pathological pair must never break a write: degrade to a minimal report.
    return {
      changed: true,
      textInserted: 0,
      textDeleted: 0,
      blocksChanged: 0,
      marks: {},
      summary: "changed (diff unavailable)",
    };
  }
}
