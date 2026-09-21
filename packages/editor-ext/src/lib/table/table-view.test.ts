import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { History } from '@tiptap/extension-history';
import { Schema } from '@tiptap/pm/model';
import type { Node as PMNode } from '@tiptap/pm/model';
import { columnResizingPluginKey, tableEditingKey } from '@tiptap/pm/tables';

import { TableView } from './table-view';
import { CustomTable } from './table';
import { TableRow } from './row';
import { TableCell } from './cell';
import { TableHeader } from './header';

/**
 * Regression guard for the table CPU burn.
 *
 * The table node had NO node view installed (the `View:` option only ever
 * reached prosemirror-tables' columnResizing plugin, whose nodeViews lose to
 * the direct EditorView prop), so ProseMirror fell back to its default
 * `ignoreMutation`, which returns false for every mutation on a node that has
 * a contentDOM. Every class write on `.tableWrapper` (the header-pin
 * controller) was then read as a foreign DOM change, ProseMirror re-rendered
 * the table, the wrapper died, the controller died, its replacement re-applied
 * the classes — ~150 `view.updateState` calls per second at idle, with header
 * pinning permanently broken as a bonus.
 *
 * These tests assert the two halves of the fix: the node view is actually
 * REGISTERED on the extension, and its `ignoreMutation` really does ignore
 * mutations outside `contentDOM`.
 */

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
    table: {
      group: 'block',
      content: 'table_row+',
      isolating: true,
      attrs: { style: { default: null }, class: { default: null } },
      toDOM: () => ['table', ['tbody', 0]],
    },
    table_row: {
      content: 'table_cell+',
      toDOM: () => ['tr', 0],
    },
    table_cell: {
      content: 'inline*',
      attrs: { colspan: { default: 1 }, colwidth: { default: null } },
      toDOM: () => ['td', 0],
    },
  },
  marks: {},
});

function buildTable(attrs: Record<string, unknown> = {}): PMNode {
  const cell = (txt: string) =>
    schema.nodes.table_cell.createChecked(null, schema.text(txt));
  const row = schema.nodes.table_row.createChecked(null, [
    cell('a'),
    cell('b'),
  ]);
  return schema.nodes.table.createChecked(attrs, [row]);
}

// Attaches the view's DOM to the document so `closest()` and `contains()`
// behave the way they do in the editor.
function mount(view: TableView) {
  document.body.appendChild(view.dom);
  return view;
}

describe('TableView.ignoreMutation', () => {
  it('ignores attribute mutations on the wrapper (the CPU-burn driver)', () => {
    const view = mount(new TableView(buildTable(), 25));

    // Exactly what the header-pin controller does.
    view.dom.classList.add('tableHeaderPinned');

    expect(
      view.ignoreMutation({
        type: 'attributes',
        target: view.dom,
        attributeName: 'class',
      } as any),
    ).toBe(true);
  });

  it('ignores attribute and childList mutations on the <table> itself', () => {
    const view = mount(new TableView(buildTable(), 25));

    expect(
      view.ignoreMutation({
        type: 'attributes',
        target: view.table,
        attributeName: 'style',
      } as any),
    ).toBe(true);
    expect(
      view.ignoreMutation({
        type: 'childList',
        target: view.colgroup,
        addedNodes: [],
        removedNodes: [],
      } as any),
    ).toBe(true);
  });

  it('does NOT ignore mutations inside contentDOM', () => {
    const view = mount(new TableView(buildTable(), 25));
    const cell = document.createElement('td');
    view.contentDOM.appendChild(document.createElement('tr')).appendChild(cell);

    expect(
      view.ignoreMutation({
        type: 'attributes',
        target: cell,
        attributeName: 'colspan',
      } as any),
    ).toBe(false);
    expect(
      view.ignoreMutation({
        type: 'characterData',
        target: cell,
      } as any),
    ).toBe(false);
    expect(
      view.ignoreMutation({
        type: 'childList',
        target: cell,
        addedNodes: [document.createElement('span')],
        removedNodes: [],
      } as any),
    ).toBe(false);
  });

  it('does NOT ignore selection mutations on the wrapper', () => {
    const view = mount(new TableView(buildTable(), 25));

    expect(
      view.ignoreMutation({ type: 'selection', target: view.dom } as any),
    ).toBe(false);
  });

});

describe('TableView DOM shape and attributes', () => {
  it('builds div.tableWrapper > table > colgroup + tbody', () => {
    const view = mount(new TableView(buildTable(), 25));

    expect(view.dom.tagName).toBe('DIV');
    expect(view.dom.classList.contains('tableWrapper')).toBe(true);
    expect(view.dom.firstElementChild).toBe(view.table);
    expect(view.table.tagName).toBe('TABLE');
    expect(view.table.children[0].tagName).toBe('COLGROUP');
    expect(view.table.children[1]).toBe(view.contentDOM);
    expect(view.contentDOM.tagName).toBe('TBODY');
  });

  it('applies the rendered HTML attributes to the <table>', () => {
    const node = buildTable({ class: 'my-table' });
    const view = mount(
      new TableView(node, 25, {
        renderAttributes: (n) => ({ class: n.attrs.class, 'data-x': '1' }),
      }),
    );

    expect(view.table.getAttribute('class')).toBe('my-table');
    expect(view.table.getAttribute('data-x')).toBe('1');
  });

  it('re-applies changed attributes on update() and drops removed ones', () => {
    const view = mount(
      new TableView(buildTable({ class: 'before' }), 25, {
        renderAttributes: (n) =>
          n.attrs.class ? { class: n.attrs.class } : { 'data-y': 'now' },
      }),
    );
    expect(view.table.getAttribute('class')).toBe('before');

    expect(view.update(buildTable({ class: 'after' }))).toBe(true);
    expect(view.table.getAttribute('class')).toBe('after');

    // The `class` attribute disappears from the rendered set entirely.
    expect(view.update(buildTable({ class: null }))).toBe(true);
    expect(view.table.hasAttribute('class')).toBe(false);
    expect(view.table.getAttribute('data-y')).toBe('now');
  });

  it('re-applies node.attrs.style on update()', () => {
    const view = mount(new TableView(buildTable({ style: null }), 25));

    view.update(buildTable({ style: 'background: red' }));

    expect(view.table.style.background).toBe('red');
  });

  it('returns false from update() when the node type differs', () => {
    const view = mount(new TableView(buildTable(), 25));
    const paragraph = schema.nodes.paragraph.createChecked(null);

    expect(view.update(paragraph)).toBe(false);
  });
});

describe('CustomTable node view registration', () => {
  it('registers a node view for the table node', () => {
    expect(CustomTable.name).toBe('table');
    expect((CustomTable as any).config.addNodeView).toBeTypeOf('function');
  });

  it('produces a node view with dom, contentDOM and ignoreMutation', () => {
    const context = {
      name: 'table',
      options: { cellMinWidth: 49, HTMLAttributes: { class: 'from-options' } },
      // No extension manager: the factory must fall back to the HTMLAttributes
      // it was handed rather than dropping every attribute.
      editor: undefined,
    };
    const factory = (CustomTable as any).config.addNodeView.call(context);
    const nodeView = factory({
      node: buildTable(),
      HTMLAttributes: { 'data-id': 'abc' },
    });

    expect(nodeView.dom.classList.contains('tableWrapper')).toBe(true);
    expect(nodeView.contentDOM.tagName).toBe('TBODY');
    expect(nodeView.ignoreMutation).toBeTypeOf('function');
    expect(nodeView.table.getAttribute('data-id')).toBe('abc');
    expect(nodeView.table.getAttribute('class')).toBe('from-options');

    // And the whole point: wrapper attribute writes are ignored.
    expect(
      nodeView.ignoreMutation({
        type: 'attributes',
        target: nodeView.dom,
        attributeName: 'class',
      }),
    ).toBe(true);
  });
});

/**
 * The unit tests above call TableView directly, so they would ALL stay green if
 * the node view stopped owning the table DOM again — which is the exact failure
 * that caused this bug (the `View:` option went to a plugin that was never in
 * the plugin set). These tests therefore drive a REAL Editor and assert on the
 * observable property: a class write on the wrapper produces no `updateState`
 * and does not destroy the wrapper, while real content edits still reach the
 * document.
 */
describe('table node view in a real editor', () => {
  const editors: Editor[] = [];

  afterEach(() => {
    while (editors.length) editors.pop()!.destroy();
    document.body.innerHTML = '';
  });

  /**
   * `resizable` defaults to FALSE here on purpose: it is the configuration in
   * which columnResizing is definitely absent from the plugin set, so the
   * CPU-burn tests below observe OUR node view and nothing else. (Historically
   * pm-tables' columnResizing installed its own fallback table node view, which
   * also ignores wrapper attribute mutations and would therefore mask the
   * regression — removing our `addNodeView` still yielded 0 updateState calls.
   * CustomTable now passes `View: null`, so that fallback no longer exists, but
   * keeping these tests on the resizing-free path keeps them independent of
   * that decision.)
   */
  function makeEditor({
    resizable = false,
    editable = true,
    history = false,
    HTMLAttributes,
  }: {
    resizable?: boolean;
    editable?: boolean;
    history?: boolean;
    HTMLAttributes?: Record<string, any>;
  } = {}) {
    const element = document.createElement('div');
    document.body.appendChild(element);
    const editor = new Editor({
      element,
      editable,
      extensions: [
        Document,
        Paragraph,
        Text,
        // Only loaded where a test needs REAL undo, so the other tests keep the
        // minimal plugin set their assertions count.
        ...(history ? [History] : []),
        CustomTable.configure({
          resizable,
          cellMinWidth: 49,
          ...(HTMLAttributes ? { HTMLAttributes } : {}),
        }),
        TableRow,
        // The real cell/header content expressions name a dozen block nodes
        // (heading, callout, …) that this minimal editor does not load, so the
        // schema would not build. Only the table node itself is under test.
        TableCell.extend({ content: 'paragraph+' }),
        TableHeader.extend({ content: 'paragraph+' }),
      ],
      content:
        '<table><tbody><tr><th>a</th><th>b</th></tr><tr><td>c</td><td>d</td></tr></tbody></table>',
    });
    editors.push(editor);
    return { editor, element };
  }

  it('does not re-render the table when the wrapper class changes', () => {
    const { editor, element } = makeEditor();
    const view: any = editor.view;

    let updates = 0;
    const originalUpdateState = view.updateState.bind(view);
    view.updateState = (state: any) => {
      updates += 1;
      return originalUpdateState(state);
    };

    const wrapper = element.querySelector('.tableWrapper')!;
    expect(wrapper).toBeTruthy();

    // Exactly what the header-pin controller does.
    wrapper.classList.add('tableHeaderPinned');
    view.domObserver.flush();

    expect(updates).toBe(0);
    // The wrapper survives, so the pin controller bound to it survives too.
    expect(element.querySelector('.tableWrapper')).toBe(wrapper);
    expect(wrapper.classList.contains('tableHeaderPinned')).toBe(true);
  });

  // NOTE — the former 'owns the table DOM even when columnResizing contributes
  // its own view' test lived here. It rested on a premise that is no longer
  // true (CustomTable passes `View: null`, so columnResizing never offers a
  // node view at all) and duplicated the `editable=true` case of the
  // parametrised ownership test in the 'column resizing' block below.

  it('still lets real content edits inside the table reach the document', () => {
    const { editor, element } = makeEditor();
    const view: any = editor.view;

    const paragraph = element.querySelector('td p')!;
    paragraph.appendChild(document.createTextNode('ZZZ'));
    view.domObserver.flush();

    expect(editor.state.doc.textContent).toContain('ZZZ');
  });

  it('applies a new row added straight into the tbody', () => {
    const { editor, element } = makeEditor();
    const view: any = editor.view;

    const tbody = element.querySelector('tbody')!;
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.appendChild(document.createElement('p')).textContent = 'QQQ';
    row.appendChild(cell);
    tbody.appendChild(row);
    view.domObserver.flush();

    expect(editor.state.doc.textContent).toContain('QQQ');
  });

  // The node view and renderHTML are two renderings of the same node — the
  // repo rules reject "keep these in sync by hand", so this is the machine
  // check. Configured HTMLAttributes are included because they are the part
  // the node view has to reproduce deliberately.
  it.each([
    ['no configured attributes', undefined],
    [
      'configured HTMLAttributes',
      { class: 'my-table', 'data-kind': 'grid' } as Record<string, any>,
    ],
  ])('keeps the live table DOM in sync with getHTML() — %s', (_label, attrs) => {
    const { editor, element } = makeEditor({ HTMLAttributes: attrs });

    const live = element.querySelector('.tableWrapper')!.outerHTML;

    // getHTML() wraps the table in whatever the doc holds; compare only the
    // wrapper. jsdom serializes inline styles with a trailing "; " that the
    // static renderer does not emit, so normalise that away.
    const rendered = editor.getHTML();
    const start = rendered.indexOf('<div class="tableWrapper">');
    const end = rendered.lastIndexOf('</div>') + '</div>'.length;
    const exported = rendered.slice(start, end);

    const normalise = (html: string) =>
      html.replace(
        /style="([^"]*)"/g,
        (_m, css: string) =>
          `style="${css.replace(/\s*;\s*$/, '').replace(/\s+/g, ' ').trim()}"`,
      );

    expect(normalise(live)).toBe(normalise(exported));
  });

  /**
   * Regression guard for "table column resizing stopped working".
   *
   * Upstream gates columnResizing on `resizable && editor.isEditable` inside
   * `addProseMirrorPlugins()`, which runs ONCE at construction. The body editor
   * is constructed with a constant `editable: false` (page-editor.tsx, Ф7) and
   * only becomes editable later via `setEditable`, which does not rebuild
   * plugins — so the plugin was never installed and no column could ever be
   * dragged. A unit test of the option cannot catch this: the whole bug is
   * "the plugin is not in the plugin set", which only a real Editor shows.
   */
  describe('column resizing', () => {
    const hasColumnResizing = (editor: Editor) =>
      editor.view.state.plugins.some(
        (plugin) => plugin.spec?.key === columnResizingPluginKey,
      );

    it('installs columnResizing even when the editor is constructed read-only', () => {
      const { editor } = makeEditor({ resizable: true, editable: false });

      expect(editor.isEditable).toBe(false);
      expect(hasColumnResizing(editor)).toBe(true);
    });

    it('installs columnResizing exactly once when constructed editable', () => {
      const { editor } = makeEditor({ resizable: true, editable: true });

      const matches = editor.view.state.plugins.filter(
        (plugin) => plugin.spec?.key === columnResizingPluginKey,
      );
      expect(matches).toHaveLength(1);
    });

    it('does not install columnResizing when resizable is off', () => {
      const { editor } = makeEditor({ resizable: false });

      expect(hasColumnResizing(editor)).toBe(false);
    });

    it('keeps tableEditing (and only one copy of it) alongside columnResizing', () => {
      const { editor } = makeEditor({ resizable: true, editable: false });

      const tableEditingPlugins = editor.view.state.plugins.filter(
        (plugin) => plugin.spec?.key === tableEditingKey,
      );
      expect(tableEditingPlugins).toHaveLength(1);
    });

    /**
     * The ownership invariant behind the 150 Hz DOM-repair fix (af06bab6):
     * columnResizing may not take over the table DOM. CustomTable passes
     * `View: null`, so pm-tables installs no node view at all and ours is the
     * only owner — asserted here with the resize plugin actually present, in
     * BOTH construction-time editability states.
     */
    it.each([true, false])(
      'keeps TableView as the table DOM owner with columnResizing present (editable=%s)',
      (editable) => {
        const { editor, element } = makeEditor({ resizable: true, editable });

        expect(hasColumnResizing(editor)).toBe(true);

        const wrapper: any = element.querySelector('.tableWrapper')!;
        expect(wrapper.pmViewDesc.spec).toBeInstanceOf(TableView);

        // And the plugin really did decline to register a competing one.
        const resizingPlugin = editor.view.state.plugins.find(
          (plugin) => plugin.spec?.key === columnResizingPluginKey,
        )!;
        expect((resizingPlugin.spec as any).props.nodeViews).toEqual({});
      },
    );

    /**
     * jsdom has no layout: `getBoundingClientRect()` is all zeros and
     * `document.elementFromPoint` does not exist, so `view.posAtCoords` cannot
     * resolve anything. Left alone, EVERY "no resize handle appears" assertion
     * passes for that reason instead of the one it claims — flipping
     * `editable: false` to `true` would not turn such a test red. These helpers
     * supply the missing layout primitives so the POSITIVE arm genuinely fires,
     * which is what gives the negative arm its meaning.
     */
    const CELL_LEFT = 0;
    const CELL_RIGHT = 100;

    function firstCellPos(editor: Editor) {
      let found = -1;
      editor.state.doc.descendants((node, pos) => {
        if (found > -1) return false;
        if (node.type.name === 'tableHeader' || node.type.name === 'tableCell') {
          found = pos;
          return false;
        }
        return true;
      });
      return found;
    }

    // Gives the first cell a real box and makes posAtCoords resolve into it.
    function armLayout(editor: Editor, cell: HTMLElement) {
      const cellPos = firstCellPos(editor);
      cell.getBoundingClientRect = () =>
        ({
          left: CELL_LEFT,
          right: CELL_RIGHT,
          top: 0,
          bottom: 20,
          width: CELL_RIGHT - CELL_LEFT,
          height: 20,
          x: CELL_LEFT,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      // `+2` lands inside the paragraph inside the cell, which is what a real
      // hit-test returns and what `cellAround` needs to walk back up from.
      (editor.view as any).posAtCoords = () => ({
        pos: cellPos + 2,
        inside: cellPos,
      });
      return cellPos;
    }

    /**
     * Drives a REAL prosemirror-tables drag of the first column to `toX`: arm
     * the handle, mousedown on the cell, mousemove on the window, mouseup. The
     * handle is armed directly rather than by hovering because the drag itself
     * is what is under test here; the hover path has its own test above.
     */
    function dragFirstColumnTo(editor: Editor, cell: HTMLElement, toX: number) {
      // jsdom has no elementFromPoint at all, and ProseMirror's own mousedown
      // handling hit-tests.
      (document as any).elementFromPoint = () => null;
      const cellPos = firstCellPos(editor);

      editor.view.dispatch(
        editor.state.tr.setMeta(columnResizingPluginKey, { setHandle: cellPos }),
      );
      cell.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, clientX: 100 }),
      );

      // `move()` bails unless the primary button is still held; jsdom does not
      // derive `which` from the constructor, so it is set explicitly.
      const drag = new MouseEvent('mousemove', { clientX: toX });
      Object.defineProperty(drag, 'which', { value: 1 });
      window.dispatchEvent(drag);

      return { cellPos, release: () => window.dispatchEvent(new MouseEvent('mouseup', { clientX: toX })) };
    }

    function columnWidths(editor: Editor) {
      const widths: (number[] | null)[] = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'tableHeader' || node.type.name === 'tableCell') {
          widths.push(node.attrs.colwidth);
        }
        return true;
      });
      return widths;
    }

    function hoverRightEdge(cell: HTMLElement) {
      cell.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          clientX: CELL_RIGHT,
          clientY: 10,
        }),
      );
    }

    /**
     * The differential pair for the runtime guard. prosemirror-tables early-
     * returns on `!view.editable` in handleMouseMove/handleMouseLeave/
     * handleMouseDown, and the handle is a decoration that only exists once a
     * handle is active. With identical layout stubs and an identical mousemove,
     * the editable editor MUST arm a handle and the read-only one MUST NOT —
     * so the read-only assertion cannot pass by accident.
     */
    it.each([
      ['editable', true],
      ['read-only', false],
    ])(
      'arms a resize handle on a cell-edge hover only when editable (%s)',
      (_label, editable) => {
        const { editor, element } = makeEditor({ resizable: true, editable });
        const cell = element.querySelector('th')!;
        const cellPos = armLayout(editor, cell);
        expect(cellPos).toBeGreaterThan(-1);

        hoverRightEdge(cell);

        const activeHandle = columnResizingPluginKey.getState(
          editor.state,
        ).activeHandle;

        if (editable) {
          expect(activeHandle).toBe(cellPos);
          expect(
            element.querySelectorAll('.column-resize-handle').length,
          ).toBeGreaterThan(0);
        } else {
          expect(activeHandle).toBe(-1);
          expect(element.querySelectorAll('.column-resize-handle')).toHaveLength(
            0,
          );
        }
      },
    );

    it('renders the table normally in a read-only editor despite the plugin', () => {
      const { editor, element } = makeEditor({
        resizable: true,
        editable: false,
      });

      const wrapper: any = element.querySelector('.tableWrapper')!;
      expect(wrapper).toBeTruthy();
      expect(wrapper.pmViewDesc.spec).toBeInstanceOf(TableView);
      expect(wrapper.querySelectorAll('td, th').length).toBe(4);
      expect(editor.state.doc.textContent).toBe('abcd');
    });

    /**
     * The main user scenario, and the only place the two style models meet:
     * prosemirror-tables' live preview writes `style.width` straight into the
     * colgroup owned by OUR TableView (which otherwise writes `min-width`), and
     * the commit re-renders that colgroup through `TableView.update()`. Pins
     * both the user-facing result and the af06bab6 ownership invariant UNDER
     * drag load, which is the only runtime force that perturbs table geometry.
     */
    it('commits a column width on a real drag and keeps TableView owning the DOM', () => {
      const { editor, element } = makeEditor({
        resizable: true,
        editable: true,
      });
      const cell = element.querySelector('th')!;
      const wrapperBefore = element.querySelector('.tableWrapper')!;

      const { release } = dragFirstColumnTo(editor, cell, 300);
      expect(
        columnResizingPluginKey.getState(editor.state).dragging,
      ).toBeTruthy();

      // The live preview reached OUR colgroup rather than one of its own.
      const colsDuringDrag = Array.from(
        element.querySelectorAll('col'),
      ) as HTMLTableColElement[];
      expect(colsDuringDrag[0].style.width).toBe('200px');

      release();

      // Committed to the document on EVERY cell of the dragged column: cells 0
      // and 2 are column one of a 2x2 table.
      const widths = columnWidths(editor);
      expect(widths[0]).toEqual([200]);
      expect(widths[2]).toEqual([200]);
      expect(widths[1]).toBeNull();
      expect(widths[3]).toBeNull();

      // Re-rendered through TableView.update(), and the wrapper is the SAME
      // element — so the header-pin controller bound to it survived the drag
      // and the af06bab6 destroy/recreate loop did not come back.
      expect(
        (element.querySelector('col') as HTMLTableColElement).style.width,
      ).toBe('200px');
      const wrapperAfter: any = element.querySelector('.tableWrapper')!;
      expect(wrapperAfter).toBe(wrapperBefore);
      expect(wrapperAfter.pmViewDesc.spec).toBeInstanceOf(TableView);
    });

    /**
     * Z1: a column going from "has width" back to "no width" must actually lose
     * its `width`. `getColStyleDeclaration` writes EITHER `width` or
     * `min-width`, so without clearing the opposite property the stale `width`
     * survives undo while the <table> recomputes — a visibly inconsistent
     * table. Unreachable before this branch (colwidth never changed at runtime
     * without columnResizing); reachable now via undo, version restore, or a
     * remote collab edit.
     */
    it('clears a committed column width again on a real undo', () => {
      const { editor, element } = makeEditor({
        resizable: true,
        editable: true,
        history: true,
      });
      const firstCol = () =>
        element.querySelector('col') as HTMLTableColElement;
      const table = () => element.querySelector('table') as HTMLTableElement;
      const styleBefore = firstCol().style.cssText;
      const tableStyleBefore = table().style.cssText;

      const { release } = dragFirstColumnTo(
        editor,
        element.querySelector('th')!,
        300,
      );
      release();
      expect(columnWidths(editor)[0]).toEqual([200]);
      expect(firstCol().style.width).toBe('200px');

      editor.commands.undo();

      // The document really did drop the width...
      expect(columnWidths(editor)[0]).toBeNull();
      // ...and so did the DOM. Before the fix the stale `width` survived here
      // while the <table> recomputed its own min-width, leaving a table that
      // was visibly wider than the document said it was.
      expect(firstCol().style.width).toBe('');
      expect(firstCol().style.minWidth).toBe('49px');
      expect(firstCol().style.cssText).toBe(styleBefore);
      expect(table().style.cssText).toBe(tableStyleBefore);
    });
  });
});
