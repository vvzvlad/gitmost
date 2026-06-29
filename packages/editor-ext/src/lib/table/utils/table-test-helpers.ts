import { Schema } from "@tiptap/pm/model";
import type { Node as PMNode } from "@tiptap/pm/model";
import { tableNodes } from "@tiptap/pm/tables";
import { EditorState, Selection } from "@tiptap/pm/state";
import { findTable } from "./query";
import { convertTableNodeToArrayOfRows } from "./convert-table-node-to-array-of-rows";

/**
 * Shared test fixtures for the table utility tests. Several test files exercise
 * the row/column move and selection helpers against a real ProseMirror table
 * schema (the same primitives the editor uses) so TableMap / cellsInRect behave
 * exactly as in production. Keeping the schema and node builders in one place
 * means a schema change (e.g. cellAttributes) is applied once instead of being
 * copied across every test file.
 *
 * This is a test-only helper (not shipped) and intentionally contains no test
 * cases, so vitest does not pick it up as a spec file.
 */

const tNodes = tableNodes({
  tableGroup: "block",
  cellContent: "inline*",
  cellAttributes: {},
});

export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0] },
    text: { group: "inline" },
    ...tNodes,
  },
  marks: {},
});

export const cell = (txt: string, attrs?: Record<string, unknown>): PMNode =>
  schema.nodes.table_cell.createChecked(attrs ?? null, schema.text(txt));
export const row = (...cells: PMNode[]): PMNode =>
  schema.nodes.table_row.createChecked(null, cells);
export const table = (...rows: PMNode[]): PMNode =>
  schema.nodes.table.createChecked(null, rows);
export const doc = (...content: PMNode[]): PMNode =>
  schema.nodes.doc.createChecked(null, content);

// Read the table's content as a grid of cell texts (rows x cols) from whatever
// table currently lives in `tr.doc`.
export const grid = (tr: any): string[][] => {
  const t = findTable(tr.doc.resolve(tr.selection.from))!;
  return convertTableNodeToArrayOfRows(t.node).map((r) =>
    r.map((c) => (c ? c.textContent : "")),
  );
};

export const stateFor = (d: PMNode) =>
  EditorState.create({ doc: d, selection: Selection.atStart(d) });

// Build a transaction whose selection is inside the doc (helpers locate the
// table via `tr.selection.$from`).
export const trFor = (d: PMNode) => stateFor(d).tr;
