import { describe, it, expect, vi } from 'vitest';

import { ResizableNodeView } from './resizable-nodeview';

/**
 * F4: the node view used to subscribe with `handleEditorUpdate.bind(this)` and
 * unsubscribe with a SECOND `.bind(this)` — a different function object, so
 * `off` never removed anything. Every image/video/drawio/excalidraw/pdf node
 * view ever constructed (and ProseMirror rebuilds them on redraw) left a
 * permanent `update` listener behind, so typing got monotonically slower over
 * a session.
 */
function makeEditor() {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  return {
    isEditable: false,
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    }),
    off: vi.fn((event: string, handler: (...args: any[]) => void) => {
      listeners.get(event)?.delete(handler);
    }),
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
  };
}

function makeNodeView(editor: any) {
  const element = document.createElement('img');
  return new ResizableNodeView({
    node: { attrs: {}, type: { name: 'image' } } as any,
    editor: editor as any,
    element,
    getPos: () => 0,
  } as any);
}

describe('ResizableNodeView editor update listener', () => {
  it('unsubscribes with the SAME reference it subscribed with', () => {
    const editor = makeEditor();
    const view = makeNodeView(editor);

    expect(editor.on).toHaveBeenCalledTimes(1);
    const [onEvent, onHandler] = editor.on.mock.calls[0];

    view.destroy();

    expect(editor.off).toHaveBeenCalledTimes(1);
    const [offEvent, offHandler] = editor.off.mock.calls[0];
    expect(offEvent).toBe(onEvent);
    expect(offHandler).toBe(onHandler);
  });

  it('leaves no listener behind after construct + destroy', () => {
    const editor = makeEditor();

    for (let i = 0; i < 5; i++) {
      makeNodeView(editor).destroy();
      expect(editor.listenerCount('update')).toBe(0);
    }
  });
});
