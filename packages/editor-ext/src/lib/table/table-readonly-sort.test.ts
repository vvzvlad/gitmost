import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { TableReadonlySort } from './table-readonly-sort';

/**
 * The plugin view used to run on EVERY ProseMirror transaction, including
 * selection-only ones and every remote Yjs step: a full-editor
 * querySelectorAll('table'), then a chevron querySelector plus three
 * setAttribute calls and a `.title` write on every <th> of every table. Table
 * drag-and-drop dispatches hover meta-transactions on every mousemove, so that
 * whole sweep ran per mouse move over a table — a large chunk of the pegged-CPU
 * symptom on table pages.
 *
 * Skipping that work costs the chevrons their implicit repair pass, so the
 * click-time self-heal below is part of the same contract.
 *
 * These tests drive the plugin view directly with hand-made fakes and assert on
 * observable DOM effects only (the chevron helpers are module-private).
 */

const CHEVRON = '.tableReadonlySortChevron';

function buildEditorRoot(): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = `
    <table>
      <tbody>
        <tr><th>Name</th><th>Qty</th></tr>
        <tr><td>b</td><td>2</td></tr>
        <tr><td>a</td><td>1</td></tr>
      </tbody>
    </table>
  `;
  document.body.appendChild(root);
  return root;
}

type FakeEditor = { isEditable: boolean };

function mountPlugin(editor: FakeEditor, root: HTMLElement, doc: object) {
  const plugins = (TableReadonlySort as any).config.addProseMirrorPlugins.call({
    editor,
  });
  const view = { dom: root, state: { doc } };
  const pluginView = (plugins[0] as any).spec.view(view);
  return { pluginView, view };
}

// Plants a chevron-classed node the plugin did not create. It survives only if
// the plugin skipped its editor-wide sweep, which is the observable proxy for
// "chevronsPresent is false".
function plantStrayChevron(root: HTMLElement) {
  const stray = document.createElement('span');
  stray.className = 'tableReadonlySortChevron';
  root.querySelector('th')!.appendChild(stray);
}

describe('TableReadonlySort plugin view', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = buildEditorRoot();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('adds chevrons to header cells when the editor is read-only', () => {
    const editor: FakeEditor = { isEditable: false };
    const { pluginView } = mountPlugin(editor, root, { id: 'a' });

    expect(root.querySelectorAll(CHEVRON).length).toBe(2);

    pluginView.destroy();
  });

  it('does nothing on a selection-only update but re-renders on a doc change', () => {
    const editor: FakeEditor = { isEditable: false };
    const docA = { id: 'a' };
    const docB = { id: 'b' };
    const { pluginView, view } = mountPlugin(editor, root, docA);

    expect(root.querySelectorAll(CHEVRON).length).toBe(2);

    // Remove a chevron behind the plugin's back: a run of its DOM work would
    // put it straight back.
    root.querySelector(CHEVRON)!.remove();

    // Selection-only transaction: same doc identity in state and prevState.
    pluginView.update(view, { doc: docA });
    expect(root.querySelectorAll(CHEVRON).length).toBe(1);

    // Doc-changing transaction: the chevrons are rebuilt.
    pluginView.update({ dom: root, state: { doc: docB } }, { doc: docA });
    expect(root.querySelectorAll(CHEVRON).length).toBe(2);

    pluginView.destroy();
  });

  it('reacts to an editability flip even without a doc change', () => {
    const editor: FakeEditor = { isEditable: false };
    const docA = { id: 'a' };
    const { pluginView, view } = mountPlugin(editor, root, docA);

    expect(root.querySelectorAll(CHEVRON).length).toBe(2);

    editor.isEditable = true;
    pluginView.update(view, { doc: docA });
    expect(root.querySelectorAll(CHEVRON).length).toBe(0);

    editor.isEditable = false;
    pluginView.update(view, { doc: docA });
    expect(root.querySelectorAll(CHEVRON).length).toBe(2);

    pluginView.destroy();
  });

  it('skips the editor-wide chevron query when none were added', () => {
    const editor: FakeEditor = { isEditable: true };
    const docA = { id: 'a' };
    const docB = { id: 'b' };
    const { pluginView } = mountPlugin(editor, root, docA);

    // Editable from the start: nothing was ever added, so the plugin must not
    // sweep the editor. A stray node planted here survives, which is the
    // observable proof that no querySelectorAll/removal pass ran.
    const stray = document.createElement('span');
    stray.className = 'tableReadonlySortChevron';
    root.querySelector('th')!.appendChild(stray);

    pluginView.update({ dom: root, state: { doc: docB } }, { doc: docA });
    expect(root.querySelectorAll(CHEVRON).length).toBe(1);

    pluginView.destroy();
  });

  it('rebuilds a chevron stripped behind its back on the next header click', () => {
    const editor: FakeEditor = { isEditable: false };
    const { pluginView } = mountPlugin(editor, root, { id: 'a' });

    // ProseMirror's renderDescs drops foreign trailing children of a contentDOM
    // when the cell is redrawn — which can happen with no doc change at all, and
    // a read-only page may never produce one. Nothing else would restore it.
    root.querySelectorAll(CHEVRON).forEach((el) => el.remove());
    expect(root.querySelectorAll(CHEVRON).length).toBe(0);

    // A click on the header cell itself (not on a chevron) self-heals.
    root.querySelector('th')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(root.querySelectorAll(CHEVRON).length).toBe(2);

    pluginView.destroy();
  });

  it('does not touch the header when the clicked cell already has its chevron', () => {
    const editor: FakeEditor = { isEditable: false };
    const { pluginView } = mountPlugin(editor, root, { id: 'a' });

    // Strip the SECOND header cell's chevron only, then click the first cell —
    // whose chevron is intact. Selecting text in a header must not trigger a
    // rewrite pass, so the missing one must still be missing afterwards.
    const cells = root.querySelectorAll<HTMLTableCellElement>('th');
    cells[1].querySelector(CHEVRON)!.remove();

    cells[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(root.querySelectorAll(CHEVRON).length).toBe(1);

    // Clicking the cell that actually lost its chevron does rebuild.
    cells[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(root.querySelectorAll(CHEVRON).length).toBe(2);

    pluginView.destroy();
  });

  // `chevronsPresent` lives in the addProseMirrorPlugins() closure (so the
  // click-time self-heal can maintain it), not in the plugin view. That closure
  // outlives an individual view, so every view() must start from a clean flag.
  // These two tests are the only ones that reuse ONE closure across several
  // views — mountPlugin() builds a fresh one per call.
  describe('chevron bookkeeping across plugin views of one closure', () => {
    const openClosure = (editor: FakeEditor) => {
      const plugins = (
        TableReadonlySort as any
      ).config.addProseMirrorPlugins.call({ editor });
      return (plugins[0] as any).spec;
    };

    it('resets the flag for a new view after the previous one was destroyed', () => {
      // Models ProseMirror's real ordering: destroyPluginViews() always runs
      // before updatePluginViews() re-creates them.
      const editor: FakeEditor = { isEditable: false };
      const docA = { id: 'a' };
      const docB = { id: 'b' };
      const spec = openClosure(editor);

      const v1 = spec.view({ dom: root, state: { doc: docA } });
      expect(root.querySelectorAll(CHEVRON).length).toBe(2);
      v1.destroy();
      expect(root.querySelectorAll(CHEVRON).length).toBe(0);

      editor.isEditable = true;
      const v2 = spec.view({ dom: root, state: { doc: docA } });

      plantStrayChevron(root);
      v2.update({ dom: root, state: { doc: docB } }, { doc: docA });
      expect(root.querySelectorAll(CHEVRON).length).toBe(1);

      v2.destroy();
    });

    it('resets the flag for a new view even without a destroy in between', () => {
      // The stricter case: nothing else clears the flag here, so this fails if
      // the `chevronsPresent = false` reset inside view() is ever dropped or the
      // flag is hoisted to module scope.
      const editor: FakeEditor = { isEditable: false };
      const docA = { id: 'a' };
      const docB = { id: 'b' };
      const spec = openClosure(editor);

      // First view is read-only: it adds chevrons and sets the flag.
      spec.view({ dom: root, state: { doc: docA } });
      expect(root.querySelectorAll(CHEVRON).length).toBe(2);
      root.querySelectorAll(CHEVRON).forEach((el) => el.remove());

      // Second view from the SAME closure, now editable: it adds nothing, so it
      // must also consider nothing present.
      editor.isEditable = true;
      const v2 = spec.view({ dom: root, state: { doc: docA } });

      plantStrayChevron(root);
      v2.update({ dom: root, state: { doc: docB } }, { doc: docA });
      expect(root.querySelectorAll(CHEVRON).length).toBe(1);

      v2.destroy();
    });
  });

  it('does not let a nested table chevron mask the outer cell self-heal', () => {
    const editor: FakeEditor = { isEditable: false };
    const nestedRoot = document.createElement('div');
    nestedRoot.innerHTML = `
      <table>
        <tbody>
          <tr>
            <th>
              Outer
              <table><tbody><tr><th>Inner</th></tr><tr><td>x</td></tr></tbody></table>
            </th>
            <th>Qty</th>
          </tr>
          <tr><td>b</td><td>2</td></tr>
        </tbody>
      </table>
    `;
    document.body.appendChild(nestedRoot);
    const { pluginView } = mountPlugin(editor, nestedRoot, { id: 'a' });

    const outerTh = nestedRoot.querySelector<HTMLTableCellElement>('th')!;
    // Outer header cells (2) + the nested table's header cell (1).
    expect(nestedRoot.querySelectorAll(CHEVRON).length).toBe(3);

    // Drop only the OUTER cell's own chevron. The nested table's chevron is
    // still a descendant of that same <th>, so a plain descendant query would
    // read "present" and suppress the rebuild.
    outerTh.querySelector(`:scope > ${CHEVRON}`)!.remove();
    expect(nestedRoot.querySelectorAll(CHEVRON).length).toBe(2);

    outerTh.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(nestedRoot.querySelectorAll(CHEVRON).length).toBe(3);
    expect(
      outerTh.querySelector(`:scope > ${CHEVRON}`),
    ).not.toBeNull();

    pluginView.destroy();
  });

  it('does not self-heal from a click outside the header row', () => {
    const editor: FakeEditor = { isEditable: false };
    const { pluginView } = mountPlugin(editor, root, { id: 'a' });

    root.querySelectorAll(CHEVRON).forEach((el) => el.remove());

    const dataCell = root.querySelectorAll('tbody > tr')[1].querySelector('td')!;
    dataCell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(root.querySelectorAll(CHEVRON).length).toBe(0);

    pluginView.destroy();
  });

  it('sorts and refreshes chevrons on click without any transaction', () => {
    const editor: FakeEditor = { isEditable: false };
    const { pluginView } = mountPlugin(editor, root, { id: 'a' });

    const chevron = root.querySelector<HTMLElement>(CHEVRON)!;
    chevron.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const firstColumn = Array.from(
      root.querySelectorAll<HTMLTableRowElement>('tbody > tr'),
    )
      .slice(1)
      .map((r) => r.cells[0].textContent);
    expect(firstColumn).toEqual(['a', 'b']);

    // Chevron state is refreshed by applySort() itself — no update() needed.
    expect(root.querySelector(CHEVRON)!.getAttribute('data-sort')).toBe('asc');

    pluginView.destroy();
  });
});
