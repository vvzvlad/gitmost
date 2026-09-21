import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

type SortDirection = 'asc' | 'desc';

type SortState = {
  col: number;
  direction: SortDirection;
};

const CHEVRON_CLASS = 'tableReadonlySortChevron';

const tableReadonlySortKey = new PluginKey('tableReadonlySort');

const sortStates = new WeakMap<HTMLTableElement, SortState>();
const originalOrders = new WeakMap<HTMLTableElement, HTMLTableRowElement[]>();

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function getColumnIndex(th: HTMLTableCellElement): number {
  const row = th.parentElement as HTMLTableRowElement;
  if (!row) return -1;
  let col = 0;
  for (let i = 0; i < row.cells.length; i++) {
    if (row.cells[i] === th) return col;
    col += row.cells[i].colSpan ?? 1;
  }
  return -1;
}

function getHeaderTh(target: EventTarget | null): HTMLTableCellElement | null {
  if (!(target instanceof Element)) return null;
  const th = target.closest('th') as HTMLTableCellElement | null;
  if (!th) return null;
  const row = th.parentElement;
  if (!row) return null;
  const tbody = row.parentElement;
  if (!tbody) return null;
  const table = tbody.closest('table');
  if (!table) return null;

  // th must be in the first row of the table (could be in thead or tbody)
  const firstRow = table.querySelector('tr');
  if (firstRow !== row) return null;

  return th;
}

function getCellText(row: HTMLTableRowElement, colIndex: number): string {
  let col = 0;
  for (let i = 0; i < row.cells.length; i++) {
    if (col === colIndex) return row.cells[i].textContent?.trim() ?? '';
    col += row.cells[i].colSpan ?? 1;
  }
  return '';
}

function getOrSaveOriginalOrder(
  table: HTMLTableElement,
  dataRows: HTMLTableRowElement[],
): HTMLTableRowElement[] {
  if (!originalOrders.has(table)) {
    originalOrders.set(table, [...dataRows]);
  }
  return originalOrders.get(table)!;
}

function sortDataRows(
  dataRows: HTMLTableRowElement[],
  colIndex: number,
  direction: SortDirection,
): HTMLTableRowElement[] {
  return [...dataRows].sort((a, b) => {
    const textA = getCellText(a, colIndex);
    const textB = getCellText(b, colIndex);
    const emptyA = textA === '';
    const emptyB = textB === '';
    if (emptyA && emptyB) return 0;
    if (emptyA) return 1;
    if (emptyB) return -1;
    const cmp = collator.compare(textA, textB);
    return direction === 'asc' ? cmp : -cmp;
  });
}

function applySort(table: HTMLTableElement, colIndex: number): void {
  const tbody = table.querySelector('tbody');
  if (!tbody) return;

  const allRows = Array.from(tbody.querySelectorAll<HTMLTableRowElement>(':scope > tr'));
  if (allRows.length === 0) return;

  const headerRow = allRows[0];
  const dataRows = allRows.slice(1);
  if (dataRows.length === 0) return;

  const current = sortStates.get(table) ?? null;
  const saved = getOrSaveOriginalOrder(table, dataRows);

  let next: SortState | null;
  if (!current || current.col !== colIndex) {
    next = { col: colIndex, direction: 'asc' };
  } else if (current.direction === 'asc') {
    next = { col: colIndex, direction: 'desc' };
  } else {
    next = null;
  }

  if (next === null) {
    sortStates.delete(table);
    tbody.append(headerRow, ...saved);
  } else {
    sortStates.set(table, next);
    const sorted = sortDataRows(saved, next.col, next.direction);
    tbody.append(headerRow, ...sorted);
  }

  updateChevrons(table);
}

const CHEVRON_SVG =
  '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">' +
  '<path d="M2.5 4.5 L6 8 L9.5 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />' +
  '</svg>';

function ensureChevron(th: HTMLTableCellElement): HTMLSpanElement {
  // `:scope >` — a plain descendant query would find the chevron of a NESTED
  // table's header living inside this cell, then write this table's sort state
  // onto the inner table's chevron.
  let chevron = th.querySelector<HTMLSpanElement>(`:scope > .${CHEVRON_CLASS}`);
  if (!chevron) {
    chevron = document.createElement('span');
    chevron.className = CHEVRON_CLASS;
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = CHEVRON_SVG;
    th.appendChild(chevron);
  }
  return chevron;
}

function updateChevrons(table: HTMLTableElement): void {
  const firstRow = table.querySelector('tr');
  if (!firstRow) return;

  const state = sortStates.get(table) ?? null;
  let col = 0;
  for (let i = 0; i < firstRow.cells.length; i++) {
    const cell = firstRow.cells[i];
    if (cell.tagName !== 'TH') {
      col += cell.colSpan ?? 1;
      continue;
    }
    const chevron = ensureChevron(cell as HTMLTableCellElement);
    let label: string;
    if (state && state.col === col) {
      chevron.setAttribute('data-sort', state.direction);
      label = state.direction === 'asc' ? 'Sort descending' : 'Clear sort';
    } else {
      chevron.removeAttribute('data-sort');
      label = 'Sort ascending';
    }
    chevron.setAttribute('data-tooltip', label);
    chevron.setAttribute('aria-label', label);
    chevron.title = label;
    col += cell.colSpan ?? 1;
  }
}

function addChevronsToAllTables(editorRoot: HTMLElement): void {
  const tables = editorRoot.querySelectorAll<HTMLTableElement>('table');
  tables.forEach((table) => updateChevrons(table));
}

function removeAllChevrons(editorRoot: HTMLElement): void {
  editorRoot
    .querySelectorAll<HTMLSpanElement>(`.${CHEVRON_CLASS}`)
    .forEach((el) => el.remove());
}

export const TableReadonlySort = Extension.create({
  name: 'tableReadonlySort',

  addProseMirrorPlugins() {
    const editor = this.editor;
    let editorRoot: HTMLElement | null = null;
    // Whether this plugin has any chevrons in the DOM. Lives here rather than
    // inside view() because BOTH writers must maintain it: the plugin view's
    // update() and the click-time self-heal below.
    let chevronsPresent = false;

    const onClick = (event: MouseEvent) => {
      if (editor.isEditable) return;
      // Only react to clicks on the chevron, not anywhere else in the header
      // cell. This lets the user click into a header to select text without
      // accidentally triggering a sort.
      if (!(event.target instanceof Element)) return;
      const chevron = event.target.closest(`.${CHEVRON_CLASS}`);
      if (!chevron) {
        // Self-heal. A chevron is a foreign child of a cell's contentDOM, so
        // ProseMirror's renderDescs drops it whenever that node is redrawn
        // (a widget decoration at a block position inside the cell, a full
        // docView rebuild) — with no doc change, which a read-only page may
        // never produce. Rebuilding here means the affordance comes back on the
        // user's first click into the header, without going back to sweeping
        // the DOM on every transaction.
        const headerCell = getHeaderTh(event.target);
        if (!headerCell) return;
        // Only rebuild when this cell's OWN chevron is missing: an ordinary click
        // to select text in a header must not rewrite data-sort / data-tooltip /
        // aria-label / title across the whole header row. `:scope >` so a nested
        // table's surviving chevron inside this cell cannot mask the gap. One
        // scoped querySelector is the entire cost of the check.
        if (headerCell.querySelector(`:scope > .${CHEVRON_CLASS}`)) return;
        const headerTable = headerCell.closest('table') as HTMLTableElement | null;
        if (headerTable) {
          updateChevrons(headerTable);
          chevronsPresent = true;
        }
        return;
      }
      const th = getHeaderTh(chevron);
      if (!th) return;
      const table = th.closest('table') as HTMLTableElement | null;
      if (!table) return;
      const colIndex = getColumnIndex(th);
      if (colIndex < 0) return;
      // applySort() refreshes this table's chevrons itself (it ends with
      // updateChevrons(table)), so the click path does not depend on the
      // plugin view's update() running afterwards. That matters now that
      // update() ignores selection-only transactions.
      applySort(table, colIndex);
    };

    return [
      new Plugin({
        key: tableReadonlySortKey,

        view(editorView) {
          editorRoot = editorView.dom as HTMLElement;
          editorRoot.addEventListener('click', onClick);

          // Tracked across updates so a transaction that changes nothing this
          // plugin renders can be skipped entirely.
          let lastEditable = editor.isEditable;
          chevronsPresent = false;

          if (!lastEditable) {
            addChevronsToAllTables(editorRoot);
            chevronsPresent = true;
          }

          return {
            update(view, prevState) {
              const editable = editor.isEditable;
              const docChanged = view.state.doc !== prevState.doc;
              const editableChanged = editable !== lastEditable;
              // Selection-only transactions (and every remote Yjs step that
              // leaves the doc identity alone) must do nothing here. This used
              // to run on EVERY transaction: a full-editor
              // querySelectorAll('table'), then three setAttribute calls plus a
              // `.title` write on every <th> of every table, plus a
              // querySelector for the chevron in each. Table drag-and-drop
              // dispatches hover meta-transactions on every mousemove, so that
              // whole sweep ran per mouse move over a table — and again for each
              // remote step on a busy collaborative page.
              if (!docChanged && !editableChanged) return;
              lastEditable = editable;

              const root = view.dom as HTMLElement;
              if (!editable) {
                addChevronsToAllTables(root);
                chevronsPresent = true;
                return;
              }
              // Skip the full-editor querySelectorAll when we know there is
              // nothing to remove.
              if (!chevronsPresent) return;
              removeAllChevrons(root);
              chevronsPresent = false;
            },
            destroy() {
              if (editorRoot) {
                editorRoot.removeEventListener('click', onClick);
                removeAllChevrons(editorRoot);
              }
              chevronsPresent = false;
            },
          };
        },
      }),
    ];
  },
});
