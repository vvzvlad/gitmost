import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { NodeView, ViewMutationRecord } from '@tiptap/pm/view';
import { getColStyleDeclaration } from './utils/col-style';

export function updateColumns(
  node: ProseMirrorNode,
  colgroup: HTMLElement,
  table: HTMLTableElement,
  cellMinWidth: number,
  overrideCol?: number,
  overrideValue?: number,
) {
  let totalWidth = 0;
  let fixedWidth = true;
  let nextDOM = colgroup.firstChild;
  const row = node.firstChild;

  if (row !== null) {
    for (let i = 0, col = 0; i < row.childCount; i += 1) {
      const { colspan, colwidth } = row.child(i).attrs;

      for (let j = 0; j < colspan; j += 1, col += 1) {
        const hasWidth =
          overrideCol === col
            ? overrideValue
            : ((colwidth && colwidth[j]) as number | undefined);

        totalWidth += hasWidth || cellMinWidth;

        if (!hasWidth) {
          fixedWidth = false;
        }

        if (!nextDOM) {
          const colElement = document.createElement('col');

          const [propertyKey, propertyValue] = getColStyleDeclaration(
            cellMinWidth,
            hasWidth,
          );

          colElement.style.setProperty(propertyKey, propertyValue);

          colgroup.appendChild(colElement);
        } else {
          const existingCol = nextDOM as HTMLTableColElement;
          const [propertyKey, propertyValue] = getColStyleDeclaration(
            cellMinWidth,
            hasWidth,
          );
          // `getColStyleDeclaration` writes EITHER `width` (sized column) or
          // `min-width` (unsized one), so a column losing its width leaves the
          // old `width` behind and the browser keeps honouring it. Upstream
          // tiptap has the same bug — plus it compares `style.width` against a
          // value it may write to `min-width`, so the compared and written
          // properties diverge — but it was UNREACHABLE here until this branch
          // installed columnResizing: without it `colwidth` never changed at
          // runtime. Now undo-after-resize, restoring an older page version and
          // remote collab edits all hit it, so the opposite property is cleared
          // explicitly. (prosemirror-tables' own TableView does not suffer from
          // this: it always assigns `style.width`, and the empty string clears.)
          const otherKey = propertyKey === 'width' ? 'min-width' : 'width';
          if (
            existingCol.style.getPropertyValue(propertyKey) !== propertyValue ||
            existingCol.style.getPropertyValue(otherKey)
          ) {
            existingCol.style.removeProperty(otherKey);
            existingCol.style.setProperty(propertyKey, propertyValue);
          }

          nextDOM = nextDOM.nextSibling;
        }
      }
    }
  }

  while (nextDOM) {
    const after = nextDOM.nextSibling;

    nextDOM.parentNode?.removeChild(nextDOM);
    nextDOM = after;
  }

  // `hasUserWidth` (and with it the divergence from `renderHTML`, which lets a
  // user style win outright) is unreachable today: the `table` node carries no
  // `style` attribute in any schema in this repo. Left as-is — it is upstream
  // tiptap's code, copied verbatim so the two stay diffable.
  const hasUserWidth =
    node.attrs.style &&
    typeof node.attrs.style === 'string' &&
    /\bwidth\s*:/i.test(node.attrs.style);

  if (fixedWidth && !hasUserWidth) {
    table.style.width = `${totalWidth}px`;
    table.style.minWidth = '';
  } else {
    table.style.width = '';
    table.style.minWidth = `${totalWidth}px`;
  }
}

export interface TableViewOptions {
  /**
   * Computes the HTML attributes to put on the <table> element for a node.
   * The render path (`CustomTable.renderHTML`) applies the node's rendered
   * attributes to the <table>; without this hook the node view would silently
   * drop them, so the edit DOM and the exported HTML would diverge. Called on
   * construction AND on every update, so attribute changes reach the DOM.
   */
  renderAttributes?: (node: ProseMirrorNode) => Record<string, unknown>;
}

export class TableView implements NodeView {
  node: ProseMirrorNode;

  cellMinWidth: number;

  dom: HTMLDivElement;

  table: HTMLTableElement;

  colgroup: HTMLTableColElement;

  contentDOM: HTMLTableSectionElement;

  private readonly renderAttributes?: (
    node: ProseMirrorNode,
  ) => Record<string, unknown>;

  // Only the attributes this view itself wrote are ever removed again, so
  // attributes owned by other code on the <table> are left alone.
  private appliedAttributeNames: string[] = [];

  // The last `node.attrs.style` this view wrote as inline style, or null.
  private appliedStyle: string | null = null;

  // WARNING — do NOT hand this class to prosemirror-tables' `columnResizing({
  // View })` (nor to tiptap's `Table.configure({ View })`, which forwards it
  // there): that call site constructs `new View(node, cellMinWidth, editorView)`
  // and would pass an EditorView into the third parameter. This view is
  // installed via `CustomTable.addNodeView()` instead, which is a direct
  // EditorView prop and wins `someProp('nodeViews')` over any plugin-provided
  // one anyway.
  constructor(
    node: ProseMirrorNode,
    cellMinWidth: number,
    options: TableViewOptions = {},
  ) {
    this.node = node;
    this.cellMinWidth = cellMinWidth;
    this.renderAttributes = options.renderAttributes;
    this.dom = document.createElement('div');
    this.dom.className = 'tableWrapper';
    this.table = this.dom.appendChild(document.createElement('table'));

    this.applyAttributes(node);

    this.colgroup = this.table.appendChild(document.createElement('colgroup'));
    updateColumns(node, this.colgroup, this.table, cellMinWidth);
    this.contentDOM = this.table.appendChild(document.createElement('tbody'));
  }

  // Mirrors what `renderHTML` puts on the <table>: the node's rendered HTML
  // attributes, then `node.attrs.style` (kept for parity with the previous
  // behaviour of this class). `updateColumns` runs afterwards and owns
  // width/min-width, exactly as it does on construction.
  private applyAttributes(node: ProseMirrorNode) {
    const attributes = this.renderAttributes?.(node) ?? {};
    const nextNames: string[] = [];

    for (const name of this.appliedAttributeNames) {
      if (!(name in attributes)) {
        this.table.removeAttribute(name);
      }
    }

    for (const [name, value] of Object.entries(attributes)) {
      if (value === null || value === undefined) {
        this.table.removeAttribute(name);
        continue;
      }
      nextNames.push(name);
      const next = String(value);
      if (this.table.getAttribute(name) !== next) {
        this.table.setAttribute(name, next);
      }
    }

    this.appliedAttributeNames = nextNames;

    // Symmetric on purpose: a node whose `style` attr goes away must lose the
    // inline style again, otherwise update() could never clear it. Guarded by
    // `appliedStyle` so cssText is only ever written when THIS view owns it —
    // an inline style put on the <table> by anyone else is left alone.
    // Inert in practice (no schema in this repo gives the `table` node a
    // `style` attribute), but `updateColumns` below reads `node.attrs.style`,
    // so the pair is kept consistent rather than half-implemented.
    if (!('style' in attributes)) {
      const style = (node.attrs.style as string | null) ?? null;
      if (style !== this.appliedStyle) {
        if (style || this.appliedStyle) {
          this.table.style.cssText = style ?? '';
        }
        this.appliedStyle = style;
      }
    }
  }

  update(node: ProseMirrorNode) {
    if (node.type !== this.node.type) return false;

    this.node = node;
    this.applyAttributes(node);
    updateColumns(node, this.colgroup, this.table, this.cellMinWidth);

    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord) {
    const target = mutation.target as Node;
    const isInsideWrapper = this.dom.contains(target);
    const isInsideContent = this.contentDOM.contains(target);

    if (isInsideWrapper && !isInsideContent) {
      if (
        mutation.type === 'attributes' ||
        mutation.type === 'childList' ||
        mutation.type === 'characterData'
      ) {
        return true;
      }
    }

    // NOTE — this view CANNOT protect the readonly-sort chevrons
    // (`.tableReadonlySortChevron`, appended into a <th> by
    // `table-readonly-sort.ts`). ProseMirror dispatches ignoreMutation on
    // `docView.nearestDesc(mutation.target)`, and a <th> has its own
    // NodeViewDesc, so chevron mutations are decided by the CELL's desc and
    // never reach this method — verified empirically by logging every call
    // into this method in a real editor while adding a chevron and writing
    // `data-sort` on it: zero calls. That is exactly why
    // `table-readonly-sort.ts` carries a click-time self-heal instead of
    // relying on the chevrons surviving.
    return false;
  }
}
