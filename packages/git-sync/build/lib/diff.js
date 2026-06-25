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
/** Build the schema once; it is pure and reused across calls. */
const schema = getSchema(docmostExtensions);
/** Recursively concatenate the plain text of a JSON node. */
function plainText(node) {
    if (!node || typeof node !== "object")
        return "";
    let out = "";
    if (typeof node.text === "string")
        out += node.text;
    if (Array.isArray(node.content)) {
        for (const child of node.content)
            out += plainText(child);
    }
    return out;
}
/** Count nodes in a JSON doc that satisfy `pred` (recursive). */
function countNodes(doc, pred) {
    let n = 0;
    const visit = (node) => {
        if (!node || typeof node !== "object")
            return;
        if (pred(node))
            n++;
        if (Array.isArray(node.content))
            for (const c of node.content)
                visit(c);
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
function countUniqueLinks(doc) {
    const hrefs = new Set();
    const visit = (node) => {
        if (!node || typeof node !== "object")
            return;
        if (node.type === "text" && Array.isArray(node.marks)) {
            for (const m of node.marks) {
                if (m && m.type === "link") {
                    const href = m.attrs && typeof m.attrs.href === "string" ? m.attrs.href : "";
                    hrefs.add(href);
                }
            }
        }
        if (Array.isArray(node.content))
            for (const c of node.content)
                visit(c);
    };
    visit(doc);
    return hrefs.size;
}
/**
 * Parse the ordered list of integers from `[N]` footnote markers found in the
 * BODY only (every top-level block before the first "Примечания..." notes
 * heading; if no such heading, the whole doc). Returned in reading order.
 */
function footnoteMarkers(doc, notesHeading) {
    const top = Array.isArray(doc?.content) ? doc.content : [];
    const notesIdx = top.findIndex((n) => n &&
        n.type === "heading" &&
        plainText(n).trim() === notesHeading);
    const bodyBlocks = notesIdx >= 0 ? top.slice(0, notesIdx) : top;
    const markers = [];
    const re = /\[(\d+)\]/g;
    for (const block of bodyBlocks) {
        const text = plainText(block);
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) {
            markers.push(Number(m[1]));
        }
    }
    return markers;
}
/** Compute the [old,new] integrity tuples for two JSON docs. */
function computeIntegrity(oldDoc, newDoc, notesHeading) {
    const images = [
        countNodes(oldDoc, (n) => n.type === "image"),
        countNodes(newDoc, (n) => n.type === "image"),
    ];
    const links = [
        countUniqueLinks(oldDoc),
        countUniqueLinks(newDoc),
    ];
    const tables = [
        countNodes(oldDoc, (n) => n.type === "table"),
        countNodes(newDoc, (n) => n.type === "table"),
    ];
    const callouts = [
        countNodes(oldDoc, (n) => n.type === "callout"),
        countNodes(newDoc, (n) => n.type === "callout"),
    ];
    const fns = [
        footnoteMarkers(oldDoc, notesHeading),
        footnoteMarkers(newDoc, notesHeading),
    ];
    return { images, links, tables, callouts, footnoteMarkers: fns };
}
/**
 * Resolve the lead text of the top-level block in a ProseMirror Node that
 * contains the given document position. Returns "" when out of range.
 */
function blockContextAt(node, pos) {
    try {
        const clamped = Math.max(0, Math.min(pos, node.content.size));
        const $pos = node.resolve(clamped);
        // depth 1 is the top-level block in a doc node.
        const block = $pos.depth >= 1 ? $pos.node(1) : $pos.node(0);
        const text = block.textContent || "";
        return text.length > 80 ? text.slice(0, 77) + "..." : text;
    }
    catch {
        return "";
    }
}
/** Truncate a string for the markdown summary. */
function truncate(s, n = 120) {
    return s.length > n ? s.slice(0, n - 3) + "..." : s;
}
/**
 * Coarse fallback: a block-by-block plain-text diff. Used only when the precise
 * changeset pipeline throws, so the tool degrades gracefully instead of failing.
 */
function coarseDiff(oldDoc, newDoc) {
    const oldBlocks = Array.isArray(oldDoc?.content) ? oldDoc.content : [];
    const newBlocks = Array.isArray(newDoc?.content) ? newDoc.content : [];
    const oldTexts = oldBlocks.map(plainText);
    const newTexts = newBlocks.map(plainText);
    const oldSet = new Set(oldTexts);
    const newSet = new Set(newTexts);
    const changes = [];
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
function renderMarkdown(result, fellBack) {
    const lines = [];
    const { summary, integrity, changes } = result;
    lines.push(`# Diff: ${summary.inserted} inserted / ${summary.deleted} deleted (${summary.blocksChanged} blocks changed)`);
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
    lines.push(`- footnoteMarkers: [${integrity.footnoteMarkers[0].join(", ")}] -> [${integrity.footnoteMarkers[1].join(", ")}]`);
    lines.push("");
    lines.push("## Changes");
    if (changes.length === 0) {
        lines.push("(no textual changes)");
    }
    else {
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
export function diffDocs(oldDocJson, newDocJson, notesHeading = "Примечания переводчика") {
    const integrity = computeIntegrity(oldDocJson, newDocJson, notesHeading);
    let changes = [];
    let inserted = 0;
    let deleted = 0;
    let fellBack = false;
    const changedBlocks = new Set();
    try {
        const oldNode = Node.fromJSON(schema, oldDocJson);
        const newNode = Node.fromJSON(schema, newDocJson);
        const tr = recreateTransform(oldNode, newNode, {
            complexSteps: false,
            wordDiffs: true,
            simplifyDiff: true,
        });
        const changeSet = ChangeSet.create(oldNode).addSteps(tr.doc, tr.mapping.maps, []);
        const simplified = simplifyChanges(changeSet.changes, newNode);
        for (const change of simplified) {
            // Deleted text lives in the OLD doc coordinate range [fromA, toA).
            if (change.toA > change.fromA) {
                const text = oldNode.textBetween(change.fromA, change.toA, "\n", " ");
                if (text.length > 0) {
                    deleted += text.length;
                    const block = blockContextAt(oldNode, change.fromA);
                    changes.push({ op: "delete", block, text });
                    if (block)
                        changedBlocks.add("d:" + block);
                }
            }
            // Inserted text lives in the NEW doc coordinate range [fromB, toB).
            if (change.toB > change.fromB) {
                const text = newNode.textBetween(change.fromB, change.toB, "\n", " ");
                if (text.length > 0) {
                    inserted += text.length;
                    const block = blockContextAt(newNode, change.fromB);
                    changes.push({ op: "insert", block, text });
                    if (block)
                        changedBlocks.add("i:" + block);
                }
            }
        }
    }
    catch {
        // Pathological pair: degrade to a coarse block-level diff so we never throw.
        fellBack = true;
        changes = coarseDiff(oldDocJson, newDocJson);
        for (const c of changes) {
            if (c.op === "insert")
                inserted += c.text.length;
            else
                deleted += c.text.length;
            if (c.block)
                changedBlocks.add(c.op[0] + ":" + c.block);
        }
    }
    const partial = {
        summary: { inserted, deleted, blocksChanged: changedBlocks.size },
        integrity,
        changes,
    };
    return { ...partial, markdown: renderMarkdown(partial, fellBack) };
}
