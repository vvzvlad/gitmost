// adapted from: https://github.com/aguingand/tiptap-markdown/blob/main/src/extensions/tiptap/clipboard.js - MIT
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { DOMParser, DOMSerializer, Fragment, Slice } from "@tiptap/pm/model";
import { find } from "linkifyjs";
import {
  markdownToHtml,
  htmlToMarkdown,
  canonicalizeFootnotes,
  FOOTNOTES_LIST_NAME,
  FOOTNOTE_REFERENCE_NAME,
} from "@docmost/editor-ext";
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
            const listTypes = ["bulletList", "orderedList", "taskList"];
            let topLevelCount = 0;
            let hasList = false;
            slice.content.forEach((node) => {
              if (listTypes.includes(node.type.name)) {
                hasList = true;
                topLevelCount += node.childCount;
              } else {
                topLevelCount++;
              }
            });

            if (!hasList || topLevelCount < 2) return null;

            const div = document.createElement("div");
            const serializer = DOMSerializer.fromSchema(this.editor.schema);
            const fragment = serializer.serializeFragment(slice.content);
            div.appendChild(fragment);
            return htmlToMarkdown(div.innerHTML);
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

            const { tr } = view.state;
            const { from, to } = view.state.selection;

            const parsed = markdownToHtml(text.replace(/\n+$/, ""));
            const body = elementFromString(parsed);
            normalizeTableColumnWidths(body);

            const parsedSlice = DOMParser.fromSchema(
              this.editor.schema,
            ).parseSlice(body, {
              preserveWhitespace: true,
            });

            // A markdown paste builds its ProseMirror fragment directly (DOM ->
            // parseSlice), bypassing the editor's footnoteSyncPlugin, which never
            // reorders an existing list. So a pasted markdown block whose footnote
            // definitions are out of order (or contains orphan defs) would be
            // stored out of order. Canonicalize the self-contained pasted block so
            // its footnotes come out reference-ordered, deduped and orphan-free
            // (issue #228). See canonicalizePastedFootnotes for why this is scoped
            // to whole-block pastes that carry their own footnotesList.
            const contentNodes = canonicalizePastedFootnotes(
              parsedSlice,
              this.editor.schema,
            );

            tr.replaceRange(from, to, contentNodes);
            const insertEnd = tr.mapping.map(from, 1);
            tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(from, insertEnd - 2)), -1));
            tr.setMeta('paste', true)
            view.dispatch(tr);
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
