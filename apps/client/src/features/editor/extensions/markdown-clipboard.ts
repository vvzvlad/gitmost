// adapted from: https://github.com/aguingand/tiptap-markdown/blob/main/src/extensions/tiptap/clipboard.js - MIT
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { DOMParser, DOMSerializer, Fragment, Slice, Node as PMNode } from "@tiptap/pm/model";
import { find } from "linkifyjs";
import {
  canonicalizeFootnotes,
  FOOTNOTES_LIST_NAME,
  FOOTNOTE_REFERENCE_NAME,
} from "@docmost/editor-ext";
// Markdown <-> ProseMirror conversion now lives ONLY in the canonical
// `@docmost/prosemirror-markdown` package (issue #347). The BROWSER entry uses
// the native `DOMParser` for its HTML->DOM stage (jsdom stays out of the client
// bundle) while producing the SAME nodes the server import does — so a paste of
// canonical markdown (`^[…]`, `<!--img …-->`, `> [!type]`, `$…$`, `==…==`,
// standalone comments) is recognized identically to import.
import {
  markdownToProseMirror,
  convertProseMirrorToMarkdown,
} from "@docmost/prosemirror-markdown/browser";
import type { Schema } from "@tiptap/pm/model";

export const MarkdownClipboard = Extension.create({
  name: "markdownClipboard",
  priority: 101,

  addOptions() {
    return {
      transformPastedText: false,
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("markdownClipboard"),
        props: {
          clipboardTextSerializer: (slice) => {
            const topLevelNodes: {
              name: string;
              childCount: number;
              cellCount?: number;
            }[] = [];
            slice.content.forEach((node) => {
              topLevelNodes.push({
                name: node.type.name,
                childCount: node.childCount,
                cellCount: countTableCells(node),
              });
            });

            const { asMarkdown, wrapBareRows } =
              classifyClipboardSelection(topLevelNodes);
            if (!asMarkdown) return null;

            // Convert the copied selection to Markdown through the canonical
            // package (issue #347), the SAME serializer the server export uses,
            // so a copied table/list matches the on-disk markdown form. The
            // converter takes a ProseMirror `doc` JSON, so wrap the slice's
            // top-level content in a synthetic doc.
            const content = slice.content.toJSON() as any[];
            if (wrapBareRows) {
              // A partial table cell-selection serializes to bare `tableRow`
              // nodes (prosemirror-tables yields the whole `table` node only for
              // a full-table selection). The converter's table case expects a
              // `table` wrapper, so wrap the bare rows in one — mirroring the old
              // <table><tbody> wrap that the HTML->markdown step needed. A partial
              // selection has no header row, so drop the GFM header separator the
              // converter always emits (it is table syntax, not data — see
              // stripHeaderSeparator).
              const md = convertProseMirrorToMarkdown({
                type: "doc",
                content: [{ type: "table", content }],
              });
              return stripHeaderSeparator(md);
            }
            return convertProseMirrorToMarkdown({ type: "doc", content });
          },
          handlePaste: (view, event, slice) => {
            if (!event.clipboardData) {
              return false;
            }

            if (this.editor.isActive("codeBlock")) {
              return false;
            }

            const text = event.clipboardData.getData("text/plain");
            const html = event.clipboardData.getData("text/html");
            const vscode = event.clipboardData.getData("vscode-editor-data");
            const vscodeData = vscode ? JSON.parse(vscode) : undefined;
            const language = vscodeData?.mode;

            const isVscodeMarkdown = language === "markdown";
            const isPlainTextOnly = !html && !vscode && !!text;

            if (!isVscodeMarkdown && !isPlainTextOnly) {
              return false;
            }

            if (isPlainTextOnly) {
              if ((view as any).input?.shiftKey || !this.options.transformPastedText) {
                return false;
              }

              const link = find(text, {
                defaultProtocol: "http",
              }).find((item) => item.isLink && item.value === text);

              if (link) {
                return false;
              }
            }

            const schema = this.editor.schema;
            // Capture the target range NOW. markdownToProseMirror RETURNS A
            // PROMISE (kept async only for the Node consumers' contract; the
            // conversion pipeline itself is synchronous), so the actual replace
            // happens on the next microtask. No user input can interleave a
            // microtask, so the state is unchanged when we dispatch — but we
            // still re-read the live state before replacing and, if the doc did
            // change under us, fall back to the live selection rather than the
            // captured (now-stale) range.
            const from = view.state.selection.from;
            const to = view.state.selection.to;
            const startDoc = view.state.doc;
            const md = text.replace(/\n+$/, "");

            void markdownToProseMirror(md)
              .then((doc) => {
                if (view.isDestroyed) return;
                // Canonical PM-JSON -> HTML via the LIVE editor schema, then
                // reuse the UNCHANGED downstream seam (normalizeTableColumnWidths
                // + parseSlice + canonicalizePastedFootnotes). The JSON->HTML->
                // JSON hop is lossless (same schema both directions); it lets the
                // existing paste-insertion logic stay byte-identical — only the
                // SOURCE of the markdown conversion changed (issue #347 guardrail:
                // no converter logic in the client, only a call into the package).
                const node = PMNode.fromJSON(schema, doc);
                const div = document.createElement("div");
                DOMSerializer.fromSchema(schema).serializeFragment(
                  node.content,
                  { document },
                  div,
                );

                const body = elementFromString(div.innerHTML);
                normalizeTableColumnWidths(body);

                const parsedSlice = DOMParser.fromSchema(schema).parseSlice(
                  body,
                  { preserveWhitespace: true },
                );

                // A markdown paste builds its ProseMirror fragment directly (DOM
                // -> parseSlice), bypassing the editor's footnoteSyncPlugin, which
                // never reorders an existing list. So a pasted markdown block whose
                // footnote definitions are out of order (or contains orphan defs)
                // would be stored out of order. Canonicalize the self-contained
                // pasted block so its footnotes come out reference-ordered, deduped
                // and orphan-free (issue #228). See canonicalizePastedFootnotes for
                // why this is scoped to whole-block pastes that carry their own
                // footnotesList.
                const contentNodes = canonicalizePastedFootnotes(
                  parsedSlice,
                  schema,
                );

                // Target the captured range (normally still valid — same
                // microtask). If the doc changed under us since capture, the
                // captured absolute from/to are stale, so fall back to the live
                // selection rather than StepMap-mapping the old range.
                const tr = view.state.tr;
                let mappedFrom = from;
                let mappedTo = to;
                if (view.state.doc !== startDoc) {
                  // Defensive: if the doc changed under us, fall back to the
                  // current selection rather than a stale absolute range.
                  mappedFrom = view.state.selection.from;
                  mappedTo = view.state.selection.to;
                }
                tr.replaceRange(mappedFrom, mappedTo, contentNodes);
                const insertEnd = tr.mapping.map(mappedFrom, 1);
                tr.setSelection(
                  TextSelection.near(
                    tr.doc.resolve(Math.max(mappedFrom, insertEnd - 2)),
                    -1,
                  ),
                );
                tr.setMeta("paste", true);
                view.dispatch(tr);
              })
              .catch((err) => {
                // Fail-open: a conversion error must not swallow the paste
                // silently in a way that loses the text. We already claimed the
                // event (returned true), so re-insert the raw text as a plain
                // paragraph so the user never loses their clipboard content.
                // Log it: this catch covers BOTH the converter and the success
                // `.then` body (e.g. PMNode.fromJSON throwing on a schema drift
                // between the canonical package and the live editor schema), so a
                // silent degrade to raw text would otherwise be an invisible,
                // non-reproducible regression ("my table pasted as text").
                console.error(
                  "markdown paste conversion failed, inserting raw text",
                  err,
                );
                if (view.isDestroyed) return;
                const tr = view.state.tr;
                // Same guard the success path uses: if the doc changed under us
                // since the range was captured (normally never — same microtask),
                // the captured absolute from/to are stale and would throw a
                // RangeError here (an unhandled rejection on a hot paste path).
                // Fall back to the live selection instead of a stale range.
                if (view.state.doc !== startDoc) {
                  const sel = view.state.selection;
                  tr.insertText(md, sel.from, sel.to);
                } else {
                  tr.insertText(md, from, to);
                }
                tr.setMeta("paste", true);
                view.dispatch(tr);
              });
            // Claim the paste: we insert asynchronously above.
            return true;
          },
          // Strip trailing whitespace-only paragraphs from pasted content.
          // Terminals (GNOME Terminal, etc.) often include trailing
          // whitespace in their HTML clipboard data, which ProseMirror
          // parses as an extra paragraph. Inside a list item this creates
          // an orphan empty line that breaks the list structure.
          transformPasted: (slice) => {
            let { content, openStart, openEnd } = slice;

            // Remove trailing paragraphs that contain only whitespace
            while (content.childCount > 1) {
              const lastChild = content.lastChild;
              if (
                lastChild?.type.name === "paragraph" &&
                lastChild.textContent.trim() === ""
              ) {
                const children = [];
                for (let i = 0; i < content.childCount - 1; i++) {
                  children.push(content.child(i));
                }
                content = Fragment.from(children);
              } else {
                break;
              }
            }

            if (content !== slice.content) {
              return new Slice(content, openStart, Math.max(openEnd, 1));
            }

            return slice;
          },
        },
      }),
    ];
  },
});

/**
 * Count the table cells a top-level slice node contributes. A `tableRow`
 * contributes its `childCount` (cells in that row); a whole `table`
 * contributes the SUM of cells across its rows (its own `childCount` is the
 * number of ROWS, so a 1×N single-row table would otherwise look like "one
 * cell"). Anything else contributes 0.
 */
function countTableCells(node: PMNode): number {
  if (node.type.name === "tableRow") return node.childCount;
  if (node.type.name === "table") {
    let n = 0;
    node.forEach((row) => {
      n += row.childCount;
    });
    return n;
  }
  return 0;
}

/**
 * Drop the GFM header-separator line from a serialized partial (header-less)
 * cell selection.
 *
 * The canonical converter emits EITHER a GFM pipe table (starts with "|") OR a
 * raw <table> HTML fallback (used for spanned / multi-block cells) whose
 * interior lines can be ARBITRARY cell content — e.g. a code-block line that is
 * itself separator-shaped (`| --- |`), or a diff/ASCII table pasted into a cell.
 * That fallback is multi-line and only its LINE 0 starts with "<"; a line-1
 * shape check alone would still splice a separator-shaped content line out of
 * it. A GFM pipe table serializes as [row0, separator, ...rows.slice(1)].join(
 * "\n"), so its header separator is ALWAYS line index 1 — but only a genuine
 * GFM table has one to strip. Bail on any input that does not start with "|" so
 * a fallback's content is never mangled, then guard on the separator SHAPE so a
 * headerless partial cell selection drops just its spurious separator. The regex
 * allows a single dash so a center-align marker ":-:" is matched too.
 */
export function stripHeaderSeparator(md: string): string {
  if (!md.startsWith("|")) return md;
  const lines = md.split("\n");
  if (lines.length >= 2) {
    const compact = lines[1].replace(/\s+/g, "");
    if (/^\|(?::?-+:?\|)+$/.test(compact)) lines.splice(1, 1);
  }
  return lines.join("\n");
}

/**
 * Decide whether a copied slice's plain-text clipboard payload should be
 * serialized as Markdown (instead of ProseMirror's default text serializer,
 * which joins block leaves with newlines — the "one value per line" bug for
 * tables).
 *
 * Serialize as Markdown for structured content:
 *  - lists with 2+ total items (a single copied bullet stays literal text);
 *  - a whole table (top-level `table` node);
 *  - a partial table cell-selection, which prosemirror-tables copies as bare
 *    `tableRow` nodes (only a full-table selection yields a `table` node).
 *
 * `wrapBareRows` flags the bare-rows case so the caller wraps the serialized
 * <tr> nodes in <table><tbody> before the HTML->Markdown step. Plain paragraphs
 * return asMarkdown=false so a simple text copy stays literal, and internal
 * copy/paste keeps using the richer text/html clipboard payload.
 *
 * A copied selection of exactly one table cell (`cellCount` sums to 1) is an
 * exception: it returns asMarkdown=false so the cell lands as bare text, not as
 * one-cell GFM syntax (`| T2 |` + `| --- |`).
 */
export function classifyClipboardSelection(
  nodes: { name: string; childCount: number; cellCount?: number }[],
): { asMarkdown: boolean; wrapBareRows: boolean } {
  const listTypes = ["bulletList", "orderedList", "taskList"];
  let topLevelCount = 0;
  let hasList = false;
  let hasTable = false;
  let tableRowCount = 0;
  let nonRowCount = 0;
  let totalCells = 0;

  for (const node of nodes) {
    if (listTypes.includes(node.name)) {
      hasList = true;
      topLevelCount += node.childCount;
      nonRowCount++;
    } else {
      if (node.name === "table") hasTable = true;
      if (node.name === "tableRow") tableRowCount++;
      else nonRowCount++;
      topLevelCount++;
    }
    if (node.name === "table" || node.name === "tableRow") {
      totalCells += node.cellCount ?? 0;
    }
  }

  // Bare tableRow nodes at the top level only occur for a partial cell
  // selection; a slice never mixes bare rows with other block types, so
  // "every top-level node is a row" is a safe signal to wrap-and-serialize.
  const wrapBareRows = tableRowCount > 0 && nonRowCount === 0;

  // A single copied cell (total table cells === 1) must land in the clipboard
  // as its bare text, NOT as GFM table syntax (`| T2 |` + `| --- |`). When the
  // slice is purely table structure (all bare rows, or exactly one `table`
  // node) and holds exactly one cell, return asMarkdown=false so the serializer
  // falls back to ProseMirror's plain text serialization of the cell. cellCount
  // is optional: callers that pass none leave totalCells at 0, so isSingleCell
  // stays false and their behavior is unchanged.
  const onlyTableStructure =
    (tableRowCount > 0 && nonRowCount === 0) ||
    (nodes.length === 1 && nodes[0].name === "table");
  const isSingleCell = onlyTableStructure && totalCells === 1;

  const asMarkdown =
    !isSingleCell &&
    ((hasList && topLevelCount >= 2) || hasTable || wrapBareRows);
  return { asMarkdown, wrapBareRows: wrapBareRows && !isSingleCell };
}

/**
 * Reorder/dedup the footnotes of a SELF-CONTAINED pasted markdown block to the
 * canonical invariant (the live footnoteSyncPlugin never reorders an existing
 * list, so an out-of-order pasted block would otherwise persist out of order).
 *
 * Scoped deliberately to whole-block pastes (openStart/openEnd === 0) that carry
 * their OWN footnotesList: canonicalizeFootnotes would synthesize empty
 * definitions for any reference lacking a definition, which is correct for a
 * standalone block but would be wrong for a reference-only paste that REUSES a
 * footnote already defined in the target document — so those are left untouched
 * for the paste/sync plugins to merge. Residual: when the pasted block is merged
 * into a doc that already has footnotes, ordering RELATIVE to the pre-existing
 * footnotes is still governed by the sync plugin (which does not reorder).
 *
 * Also requires at least one footnoteReference in the selection: a definitions-ONLY
 * paste (`[^a]: …` with no `[^a]` reference in the same block) has no references,
 * so canonicalizeFootnotes would drop the whole list and the paste would come out
 * EMPTY — losing the pasted text. Such a block is left as-is for the sync plugin.
 */
export function canonicalizePastedFootnotes(slice: Slice, schema: Schema): Slice {
  if (slice.openStart !== 0 || slice.openEnd !== 0) return slice;

  let hasFootnotesList = false;
  let hasReference = false;
  slice.content.forEach((node) => {
    if (node.type.name === FOOTNOTES_LIST_NAME) hasFootnotesList = true;
    // footnoteReference is an inline atom, never a top-level slice child here
    // (this function early-returns for open slices, so children are whole
    // blocks), so it is only reachable by descending.
    node.descendants((child) => {
      if (child.type.name === FOOTNOTE_REFERENCE_NAME) hasReference = true;
    });
  });
  if (!hasFootnotesList) return slice;
  // No reference anywhere -> a definitions-only paste; canonicalizing would strip
  // the reference-less list (empty paste). Leave it untouched.
  if (!hasReference) return slice;

  const content = slice.content.toJSON();
  if (!Array.isArray(content)) return slice;

  const canonical = canonicalizeFootnotes({ type: "doc", content }) as {
    content?: unknown[];
  };
  const fragment = Fragment.fromJSON(schema, canonical.content ?? []);
  return new Slice(fragment, 0, 0);
}

function elementFromString(value) {
  // add a wrapper to preserve leading and trailing whitespace
  const wrappedValue = `<body>${value}</body>`;

  return new window.DOMParser().parseFromString(wrappedValue, "text/html").body;
}

const DEFAULT_PASTE_COL_WIDTH_PX = 150;

function parsePixelWidth(el: Element): number | null {
  const attr = el.getAttribute("width");
  if (attr) {
    const n = parseInt(attr, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const style = el.getAttribute("style") || "";
  const m = style.match(/(?:^|;)\s*width\s*:\s*([\d.]+)\s*px/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function getFirstRow(table: Element): Element | null {
  const tbodyRow = table.querySelector(":scope > tbody > tr");
  if (tbodyRow) return tbodyRow;
  const theadRow = table.querySelector(":scope > thead > tr");
  if (theadRow) return theadRow;
  return table.querySelector(":scope > tr");
}

function deriveColumnWidths(table: Element): (number | null)[] | null {
  const cols = table.querySelectorAll(":scope > colgroup > col");
  if (cols.length > 0) {
    const widths: (number | null)[] = [];
    cols.forEach((col) => widths.push(parsePixelWidth(col)));
    if (widths.some((w) => w !== null)) return widths;
  }

  const firstRow = getFirstRow(table);
  if (!firstRow) return null;

  const widths: (number | null)[] = [];
  Array.from(firstRow.children)
    .filter((c) => c.tagName === "TD" || c.tagName === "TH")
    .forEach((cell) => {
      const colspan = parseInt(cell.getAttribute("colspan") || "1", 10) || 1;
      const w = parsePixelWidth(cell);
      for (let i = 0; i < colspan; i++) {
        widths.push(w !== null ? Math.round(w / colspan) : null);
      }
    });
  if (widths.length === 0 || widths.every((w) => w === null)) return null;
  return widths;
}

// Mirror of server normalizeTableColumnWidths (see import/utils/table-utils.ts):
// markdown source has no widths, so without this every pasted table renders
// at table-layout:fixed/100% and squashes columns to fit the editor instead of
// letting .tableWrapper's overflow-x: auto scroll.
export function normalizeTableColumnWidths(root: Element): void {
  root.querySelectorAll("table").forEach((table) => {
    const firstRow = getFirstRow(table);
    if (!firstRow) return;

    let colWidths = deriveColumnWidths(table);
    if (!colWidths) {
      let count = 0;
      Array.from(firstRow.children)
        .filter((c) => c.tagName === "TD" || c.tagName === "TH")
        .forEach((cell) => {
          count += parseInt(cell.getAttribute("colspan") || "1", 10) || 1;
        });
      if (count === 0) return;
      colWidths = new Array(count).fill(DEFAULT_PASTE_COL_WIDTH_PX);
    }

    let col = 0;
    Array.from(firstRow.children)
      .filter((c) => c.tagName === "TD" || c.tagName === "TH")
      .forEach((cell) => {
        if (cell.getAttribute("colwidth")) {
          col += parseInt(cell.getAttribute("colspan") || "1", 10) || 1;
          return;
        }
        const colspan = parseInt(cell.getAttribute("colspan") || "1", 10) || 1;
        const slice = colWidths!.slice(col, col + colspan);
        col += colspan;
        if (slice.length === 0 || slice.every((w) => w === null)) return;
        const values = slice.map((w) => (w == null ? 100 : w));
        cell.setAttribute("colwidth", values.join(","));
      });
  });
}
