/**
 * Headless, Docmost-equivalent document diff.
 *
 * Docmost's history editor computes a change set with the exact pipeline below
 * (recreateTransform -> ChangeSet.addSteps -> simplifyChanges) and renders it as
 * editor decorations. This module runs the SAME computation but serializes the
 * result to text + integrity counts instead of decorations, so a diff can be
 * previewed without a browser.
 *
 * recreateTransform here comes from @fellow/prosemirror-recreate-transform, the
 * maintained published fork of the MIT prosemirror-recreate-steps source that
 * Docmost vendors in @docmost/editor-ext; it exposes the identical
 * recreateTransform(fromDoc, toDoc, { complexSteps, wordDiffs, simplifyDiff })
 * signature.
 *
 * If recreateTransform / the changeset throws on a pathological document pair,
 * we fall back to a coarse block-level text diff so the tool never hard-fails.
 */

import { getSchema } from "@tiptap/core";
import { Node } from "@tiptap/pm/model";
import { ChangeSet, simplifyChanges } from "@tiptap/pm/changeset";
import { recreateTransform } from "@fellow/prosemirror-recreate-transform";
import { docmostExtensions } from "./docmost-schema.js";

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
  footnoteMarkers: [number[], number[]];
}

export interface DiffResult {
  summary: { inserted: number; deleted: number; blocksChanged: number };
  integrity: DiffIntegrity;
  changes: DiffChange[];
  /** Human-readable unified-ish summary. */
  markdown: string;
}

/** Build the schema once; it is pure and reused across calls. */
const schema = getSchema(docmostExtensions);

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

/**
 * Parse the ordered list of integers from `[N]` footnote markers found in the
 * BODY only (every top-level block before the first "Примечания..." notes
 * heading; if no such heading, the whole doc). Returned in reading order.
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
  const fns: [number[], number[]] = [
    footnoteMarkers(oldDoc, notesHeading),
    footnoteMarkers(newDoc, notesHeading),
  ];
  return { images, links, tables, callouts, footnoteMarkers: fns };
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
  const integrity = computeIntegrity(oldDocJson, newDocJson, notesHeading);

  let changes: DiffChange[] = [];
  let inserted = 0;
  let deleted = 0;
  let fellBack = false;
  const changedBlocks = new Set<string>();

  try {
    const oldNode = Node.fromJSON(schema, oldDocJson);
    const newNode = Node.fromJSON(schema, newDocJson);
    const tr = recreateTransform(oldNode, newNode, {
      complexSteps: false,
      wordDiffs: true,
      simplifyDiff: true,
    });
    const changeSet = ChangeSet.create(oldNode).addSteps(
      tr.doc,
      tr.mapping.maps,
      [],
    );
    const simplified = simplifyChanges(changeSet.changes, newNode);

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
  } catch {
    // Pathological pair: degrade to a coarse block-level diff so we never throw.
    fellBack = true;
    changes = coarseDiff(oldDocJson, newDocJson);
    for (const c of changes) {
      if (c.op === "insert") inserted += c.text.length;
      else deleted += c.text.length;
      if (c.block) changedBlocks.add(c.op[0] + ":" + c.block);
    }
  }

  const partial: Omit<DiffResult, "markdown"> = {
    summary: { inserted, deleted, blocksChanged: changedBlocks.size },
    integrity,
    changes,
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
   * (images/links/tables/callouts). Surfaces structural mutations that touch
   * neither text nor marks (e.g. insert_image, deleting a table) which diffDocs
   * — being TEXT-only — would otherwise report as "no content change".
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
 * makes `changed` true for an image/table/callout/link count change that diffs
 * to zero text — closing a verify blind spot for insert_image, delete_node on a
 * table, etc.
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
    // images/links/tables/callouts. Include a type only when old != new.
    const integrity = diff.integrity;
    const structure: Record<string, [number, number]> = {};
    const countTypes: ["images", "links", "tables", "callouts"] = [
      "images",
      "links",
      "tables",
      "callouts",
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
