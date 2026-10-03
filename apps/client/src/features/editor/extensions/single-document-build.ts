import { Extension, type Editor } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";

/**
 * Builds an editor's document DOM once instead of twice.
 *
 * Stock tiptap builds the whole document twice:
 * - When the editor is created, EditorContent has not set
 *   `editor.contentComponent` (its portal store) yet, so ReactNodeViewRenderer
 *   returns `{}` and every React node view is drawn through plain renderHTML.
 * - When EditorContent mounts, it sets the store and calls
 *   `editor.createNodeViews()`, which hands the view newly created node view
 *   closures. ProseMirror sees changed node views, throws the docView away and
 *   rebuilds it with the React node views (0.9-1.7 s on a 9000-block page).
 *
 * Per editor, this extension:
 * 1. Gives the view the same node/mark view factories every time
 *    (`extensionManager.nodeViews` / `markViews` are memoized), so the
 *    `createNodeViews()` on mount changes nothing and ProseMirror keeps the
 *    docView. After an EditorContent unmount (which sets `nodeViews: {}`) the
 *    next mount still swaps the factories back in and rebuilds, as it must.
 * 2. Runs each factory with a stand-in store while no EditorContent is
 *    mounted, so React node views are real from the first build. Their
 *    renderers report to the stand-in instead of rendering.
 * 3. When EditorContent mounts and calls `createNodeViews()`, renders those
 *    renderers into its real store, which the discarded rebuild used to do.
 *
 * This leans on library internals (@tiptap/react 3.20.4, @tiptap/core 3.20.4,
 * prosemirror-view 1.40): the untyped `editor.contentComponent`, the store
 * check in ReactNodeViewRenderer, ReactRenderer reporting through
 * `contentComponent.setRenderer`, EditorContent calling `createNodeViews()`
 * right after it sets the store, and ProseMirror redrawing only when a node
 * view function changes identity. single-document-build.test.tsx fails if an
 * upgrade breaks any of that.
 */

type ViewFactories = Record<string, unknown>;

// Renderers held for adoption are pruned of destroyed ones whenever the set
// grows past twice its last pruned size, never below this floor.
const PRUNE_FLOOR = 256;
const NO_PORTALS = {};

function installSingleDocumentBuild(editor: Editor) {
  // `contentComponent` is not part of tiptap's typings.
  const host = editor as any;
  const manager = host.extensionManager;

  // Renderers built while no EditorContent was mounted, still to be rendered
  // into the real store.
  const pending = new Set<ReactRenderer>();
  let pruneAt = PRUNE_FLOOR;

  const hold = (renderer: ReactRenderer) => {
    pending.add(renderer);
    if (pending.size <= pruneAt) return;
    // Node views replaced or deleted before the mount (a hidden live editor
    // keeps receiving collab updates) leave destroyed renderers behind.
    for (const r of pending) if (r.destroyed) pending.delete(r);
    pruneAt = Math.max(PRUNE_FLOOR, pending.size * 2);
  };

  const standInStore = {
    subscribe: () => () => {},
    getSnapshot: () => NO_PORTALS,
    getServerSnapshot: () => NO_PORTALS,
    setRenderer: (_id: string, renderer: ReactRenderer) => hold(renderer),
    removeRenderer: () => {},
  };

  const withStandInStore = (factories: ViewFactories): ViewFactories =>
    Object.fromEntries(
      Object.entries(factories).map(([name, factory]) => {
        if (typeof factory !== "function") return [name, factory];
        const wrapped = (...args: unknown[]) => {
          if (host.contentComponent) return factory(...args);
          const previous = host.contentComponent;
          host.contentComponent = standInStore;
          try {
            const view = factory(...args);
            // A renderer created while editor.isInitialized is false defers
            // its first render to a microtask and never reports to the
            // stand-in, so pick it up from the node/mark view as well.
            if (view?.renderer instanceof ReactRenderer) hold(view.renderer);
            return view;
          } finally {
            host.contentComponent = previous;
          }
        };
        return [name, wrapped];
      }),
    );

  for (const name of ["nodeViews", "markViews"] as const) {
    const build = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(manager),
      name,
    ).get;
    let factories: ViewFactories | undefined;
    Object.defineProperty(manager, name, {
      configurable: true,
      get: () => (factories ??= withStandInStore(build.call(manager))),
    });
  }

  // An editor destroyed before it ever mounted must not keep its renderers (and
  // through them the destroyed view's DOM) alive.
  editor.on("destroy", () => pending.clear());

  const createNodeViews = host.createNodeViews.bind(host);
  host.createNodeViews = () => {
    createNodeViews();
    if (!host.contentComponent) return;
    const renderers = [...pending];
    pending.clear();
    pruneAt = PRUNE_FLOOR;
    // A no-op for renderers destroyed in the meantime.
    for (const renderer of renderers) renderer.render();
  };
}

export const SingleDocumentBuild = Extension.create({
  name: "singleDocumentBuild",

  onBeforeCreate() {
    installSingleDocumentBuild(this.editor);
  },
});
