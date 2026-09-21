import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

import { attach, detach, getController } from './controller';
import { pinOffsetWatcher } from './offset';

const tableHeaderPinKey = new PluginKey('tableHeaderPin');

export const TableHeaderPin = Extension.create({
  name: 'tableHeaderPin',

  addProseMirrorPlugins() {
    let editorRoot: HTMLElement | null = null;
    let domObserver: MutationObserver | null = null;
    const tracked = new Set<HTMLElement>();
    let rafHandle: number | null = null;

    const reconcile = () => {
      rafHandle = null;
      if (!editorRoot) return;
      const current = new Set(
        editorRoot.querySelectorAll<HTMLElement>('.tableWrapper'),
      );
      for (const w of tracked) {
        if (!current.has(w)) {
          detach(w);
          tracked.delete(w);
        }
      }
      for (const w of current) {
        if (!tracked.has(w)) {
          attach(w);
          tracked.add(w);
        }
      }
    };

    const schedule = () => {
      if (rafHandle !== null) return;
      rafHandle = requestAnimationFrame(reconcile);
    };

    return [
      new Plugin({
        key: tableHeaderPinKey,

        view(editorView) {
          editorRoot = editorView.dom as HTMLElement;

          schedule();

          domObserver = new MutationObserver(schedule);
          domObserver.observe(editorRoot, { subtree: true, childList: true });

          return {
            update(view, prevState) {
              if (!editorRoot) return;
              // The pin anchors mount/unmount with the editor's mode (the fixed
              // toolbar only exists while editing), and the watcher deliberately
              // observes only the anchors themselves — so give it a chance to
              // re-resolve them on every view update. sync() only SCHEDULES a
              // frame (and is a no-op unless some table is pinned), so this adds
              // no geometry read inside PM's updateStateInner, where the DOM has
              // just been written and layout is dirty.
              pinOffsetWatcher.sync();
              if (view.state.doc === prevState.doc) return;
              editorRoot
                .querySelectorAll<HTMLElement>('.tableWrapper')
                .forEach((w) => getController(w)?.refresh());
            },
            destroy() {
              if (rafHandle !== null) {
                cancelAnimationFrame(rafHandle);
                rafHandle = null;
              }
              domObserver?.disconnect();
              domObserver = null;
              for (const w of tracked) detach(w);
              tracked.clear();
              editorRoot = null;
            },
          };
        },
      }),
    ];
  },
});
