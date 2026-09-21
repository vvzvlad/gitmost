import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { TableHandlePluginSpec, TableDndKey, TableHandleState } from './dnd-extension';

/**
 * F2: drop the table handles when the editor loses focus.
 *
 * `_onSelectionUpdate` sets `hoveringCell` whenever the CARET sits in a cell,
 * and nothing ever cleared it — so one click into any table left the three
 * floating handles (and their floating-ui `autoUpdate` watchers) mounted for
 * the rest of the session. The blur path unmounts them, but must not fight a
 * menu (`frozen`), a drag (`dragging`), or dispatch a transaction on every
 * blur once the state is already clear.
 */

const CLEARED: TableHandleState = {
  hoveringCell: null,
  tableNode: null,
  tablePos: null,
  dragging: null,
  frozen: false,
};

const HOVERING: TableHandleState = {
  ...CLEARED,
  hoveringCell: { cellPos: 3 } as any,
  tableNode: {} as any,
  tablePos: 0,
};

function makeEditor(state: TableHandleState) {
  const handlers = new Map<string, () => void>();
  const dispatch = vi.fn();
  const tr = {
    setMeta: vi.fn(function (this: any) {
      return this;
    }),
  };
  const editor = {
    isDestroyed: false,
    isFocused: false,
    pluginState: state,
    options: { element: document.createElement('div') },
    state: { tr },
    view: { dispatch },
    on: (event: string, handler: () => void) => handlers.set(event, handler),
    off: (event: string) => handlers.delete(event),
    emit: (event: string) => handlers.get(event)?.(),
    dispatch,
  };
  return editor as any;
}

function mountSpec(editor: any) {
  const spec = new TableHandlePluginSpec(editor);
  // The plugin `view()` is what registers the blur subscription.
  const view = (spec as any).view();
  return { spec, destroy: view.destroy };
}

// jsdom has no PointerEvent constructor; MouseEvent carries `buttons`, which
// is the property the plugin actually reads.
function pointerEvent(type: string, buttons: number) {
  document.dispatchEvent(new MouseEvent(type, { buttons, bubbles: true }));
}

let getStateSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  // The spec reads the plugin state through the key; back it with the editor
  // stub's `pluginState` so a test can flip `frozen` / `dragging`.
  getStateSpy = vi
    .spyOn(TableDndKey, 'getState')
    .mockImplementation((state: any) => state?.pluginState ?? null);
});

afterEach(() => {
  getStateSpy.mockRestore();
  vi.useRealTimers();
});

// `TableDndKey.getState(this.editor.state)` is called with `editor.state`, so
// mirror the plugin state onto it.
function withPluginState(editor: any, state: TableHandleState) {
  editor.state.pluginState = state;
  editor.pluginState = state;
}

describe('table handles blur clear', () => {
  it('clears the handle state a beat after the editor blurs', () => {
    const editor = makeEditor(HOVERING);
    withPluginState(editor, HOVERING);
    const { destroy } = mountSpec(editor);

    editor.emit('blur');
    vi.advanceTimersByTime(1000);

    expect(editor.view.dispatch).toHaveBeenCalledTimes(1);
    expect(editor.state.tr.setMeta).toHaveBeenCalledWith(TableDndKey, {
      hoveringCell: null,
      tableNode: null,
      tablePos: null,
    });
    // Never pollutes undo history.
    expect(editor.state.tr.setMeta).toHaveBeenCalledWith('addToHistory', false);

    destroy();
  });

  it('does not dispatch when the state is already cleared', () => {
    const editor = makeEditor(CLEARED);
    withPluginState(editor, CLEARED);
    const { destroy } = mountSpec(editor);

    editor.emit('blur');
    vi.advanceTimersByTime(1000);

    expect(editor.view.dispatch).not.toHaveBeenCalled();

    destroy();
  });

  it('does not clear while a drag is in flight', () => {
    const editor = makeEditor(HOVERING);
    withPluginState(editor, {
      ...HOVERING,
      dragging: { orientation: 'col', index: 1 },
    });
    const { destroy } = mountSpec(editor);

    editor.emit('blur');
    vi.advanceTimersByTime(1000);

    expect(editor.view.dispatch).not.toHaveBeenCalled();

    destroy();
  });

  it('does not clear while a handle menu holds the handles frozen', () => {
    const editor = makeEditor(HOVERING);
    withPluginState(editor, { ...HOVERING, frozen: true });
    const { destroy } = mountSpec(editor);

    editor.emit('blur');
    vi.advanceTimersByTime(1000);

    expect(editor.view.dispatch).not.toHaveBeenCalled();

    destroy();
  });

  it('does not clear while a pointer is still down (click-and-hold on a handle)', () => {
    const editor = makeEditor(HOVERING);
    withPluginState(editor, HOVERING);
    const { destroy } = mountSpec(editor);

    pointerEvent('pointerdown', 1);
    editor.emit('blur');
    vi.advanceTimersByTime(600);

    expect(editor.view.dispatch).not.toHaveBeenCalled();

    // Released without a drag / menu — now it settles.
    pointerEvent('pointerup', 0);
    vi.advanceTimersByTime(1000);
    expect(editor.view.dispatch).toHaveBeenCalledTimes(1);

    destroy();
  });

  it('heals a stale pointer flag from `buttons` on any later pointer event', () => {
    const editor = makeEditor(HOVERING);
    withPluginState(editor, HOVERING);
    const { destroy } = mountSpec(editor);

    // Button pressed, then released outside the window: no pointerup/cancel
    // is delivered, but the next pointermove carries `buttons: 0`.
    pointerEvent('pointerdown', 1);
    editor.emit('blur');
    vi.advanceTimersByTime(300);
    expect(editor.view.dispatch).not.toHaveBeenCalled();

    pointerEvent('pointermove', 0);
    vi.advanceTimersByTime(300);
    expect(editor.view.dispatch).toHaveBeenCalledTimes(1);

    destroy();
  });

  it('keeps the handles alive for a press-and-hold that keeps producing events', () => {
    const editor = makeEditor(HOVERING);
    withPluginState(editor, HOVERING);
    const { destroy } = mountSpec(editor);

    // Grip pressed (which blurs the editor) and held while the user decides
    // where to drop. The drag has not started, so neither `dragging` nor
    // `frozen` is set — only the pointer state protects the handles. Clearing
    // here would unmount the draggable and make the drag impossible.
    pointerEvent('pointerdown', 1);
    editor.emit('blur');

    for (let elapsed = 0; elapsed < 5000; elapsed += 200) {
      vi.advanceTimersByTime(200);
      pointerEvent('pointermove', 1);
    }

    expect(editor.view.dispatch).not.toHaveBeenCalled();

    destroy();
  });

  it('parks (no perpetual timer) when the pointer flag is stuck, and clears on the next pointer event', () => {
    const editor = makeEditor(HOVERING);
    withPluginState(editor, HOVERING);
    const { destroy } = mountSpec(editor);

    // A native HTML5 drag swallows the pointer events; nothing reports the
    // release, and no further pointer event arrives.
    pointerEvent('pointerdown', 1);
    editor.emit('blur');
    vi.advanceTimersByTime(10_000);

    // Terminal state: nothing is left running — no 250ms wakeup forever.
    expect(vi.getTimerCount()).toBe(0);

    // The stuck flag heals from `buttons` on the next pointer event, which
    // also resumes the parked clear.
    pointerEvent('pointermove', 0);
    vi.advanceTimersByTime(1000);

    expect(editor.view.dispatch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    // And it does not keep dispatching afterwards.
    withPluginState(editor, CLEARED);
    pointerEvent('pointermove', 0);
    vi.advanceTimersByTime(10_000);
    expect(editor.view.dispatch).toHaveBeenCalledTimes(1);

    destroy();
  });

  it('resumes a parked clear from dragend / window blur too', () => {
    const editor = makeEditor(HOVERING);
    withPluginState(editor, HOVERING);
    const { destroy } = mountSpec(editor);

    pointerEvent('pointerdown', 1);
    editor.emit('blur');
    vi.advanceTimersByTime(10_000);
    expect(editor.view.dispatch).not.toHaveBeenCalled();

    document.dispatchEvent(new Event('dragend', { bubbles: true }));
    vi.advanceTimersByTime(1000);

    expect(editor.view.dispatch).toHaveBeenCalledTimes(1);

    destroy();
  });

  it('does not fire after destroy()', () => {
    const editor = makeEditor(HOVERING);
    withPluginState(editor, HOVERING);
    const { destroy } = mountSpec(editor);

    editor.emit('blur');
    destroy();
    vi.advanceTimersByTime(10_000);

    expect(editor.view.dispatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('re-derives the handles when the editor is focused again', () => {
    const editor = makeEditor(HOVERING);
    withPluginState(editor, HOVERING);
    const { spec, destroy } = mountSpec(editor);

    editor.emit('blur');
    vi.advanceTimersByTime(1000);
    expect(editor.view.dispatch).toHaveBeenCalledTimes(1);
    withPluginState(editor, CLEARED);

    // Alt-tab back: no selection change happens, so `selectionUpdate` never
    // fires — the focus handler must re-derive from the caret's cell itself.
    const onSelectionUpdate = vi.spyOn(spec as any, '_onSelectionUpdate');
    editor.emit('focus');

    expect(onSelectionUpdate).toHaveBeenCalledTimes(1);

    destroy();
  });

  it('cancels a pending clear when the editor regains focus', () => {
    const editor = makeEditor(HOVERING);
    withPluginState(editor, HOVERING);
    const { destroy } = mountSpec(editor);

    editor.emit('blur');
    editor.emit('focus');
    vi.advanceTimersByTime(2000);

    expect(editor.view.dispatch).not.toHaveBeenCalled();

    destroy();
  });
});
