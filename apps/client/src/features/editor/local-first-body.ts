import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import * as Y from "yjs";

/**
 * Local-first body (#564): the two mechanisms that make an "instant body from
 * the local ydoc" safe.
 *
 *  1. `isYdocBodyNonEmpty` — do NOT trust the IndexedDB "synced" event as proof
 *     that there is something to show: y-indexeddb emits it even for an empty
 *     doc. Guard 1 keys the early swap on real content.
 *  2. `createBodyWriteGuard` — enforce read-only at the YJS level, not just in
 *     the UI. `editor.setEditable(false)` stops ProseMirror's edit handlers, but
 *     ANY doc-changing transaction that still reaches the view (a plugin's
 *     appendTransaction, a stray programmatic command, a future code path) would
 *     be written straight into the Y.Doc by y-prosemirror's sync plugin and
 *     merged/pushed to the server the moment the socket connects. The guard
 *     rejects such transactions at `filterTransaction`, which prosemirror-state
 *     also applies to plugin-appended transactions.
 */

/** Collab field tiptap's Collaboration extension binds the body to. */
export const COLLAB_BODY_FIELD = "default";

function nodeHasContent(node: Y.XmlElement | Y.XmlText | Y.XmlHook): boolean {
  if (node instanceof Y.XmlText) return node.length > 0;
  if (node instanceof Y.XmlElement) {
    // Any children => content.
    if (node.length > 0) return true;
    // A childless node that isn't a paragraph still carries content (image,
    // horizontal rule, embed, ...). A childless paragraph is the empty doc.
    return node.nodeName !== "paragraph";
  }
  return true;
}

/**
 * Whether the page's local ydoc holds real body content.
 *
 * Fails CLOSED (false) on any error: "no local content" simply keeps today's
 * behavior (static copy until remote sync), which is always safe.
 */
export function isYdocBodyNonEmpty(ydoc: Y.Doc): boolean {
  try {
    const fragment = ydoc.getXmlFragment(COLLAB_BODY_FIELD);
    if (fragment.length === 0) return false;
    return fragment.toArray().some(nodeHasContent);
  } catch {
    return false;
  }
}

export interface BodyWriteGuardOptions {
  /**
   * Whether the guard is armed at all. Off when the local-first flag is off, so
   * the flag-off path behaves byte-identically to today (the editor is created
   * at mount and its plugins may seed the ydoc exactly as they do now).
   */
  isActive: () => boolean;
  /** Whether local writes are allowed (the remote room confirmed a sync). */
  canWrite: () => boolean;
}

export const bodyWriteGuardPluginKey = new PluginKey("gitmostBodyWriteGuard");

/**
 * Blocks every LOCAL doc mutation until the remote collab room has confirmed a
 * sync (#564, guard 2 — the Yjs-level half).
 *
 * Passed through:
 *  - transactions that don't change the doc (selection, decorations, awareness),
 *  - changes that ORIGINATE from Yjs (`isChangeOrigin`) — i.e. the local ydoc
 *    hydrating the editor and later remote updates merging in. Blocking those
 *    would leave the body blank.
 *
 * Rejected: anything else that changes the doc while read-only. The predicates
 * are read live (refs), so arming/disarming the guard never recreates the editor.
 */
export function createBodyWriteGuard(options: BodyWriteGuardOptions) {
  return Extension.create({
    name: "gitmostBodyWriteGuard",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: bodyWriteGuardPluginKey,
          filterTransaction: (tr) => {
            if (!options.isActive()) return true;
            if (options.canWrite()) return true;
            if (!tr.docChanged) return true;
            // Yjs -> ProseMirror (local ydoc hydration, remote merges).
            if (isChangeOrigin(tr)) return true;
            return false;
          },
        }),
      ];
    },
  });
}
