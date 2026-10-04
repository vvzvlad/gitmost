import { findChildren, splitExtensions } from "@tiptap/core";
import type { Extensions } from "@tiptap/core";
import { generateNodeId } from "../utils";
import { UniqueID as TiptapUniqueID } from "@tiptap/extension-unique-id";

// The (unexported) `resolveTypes` of @tiptap/extension-unique-id 3.20.4.
const resolveTypes = (types: string[] | "all", extensions: Extensions) => {
  if (types !== "all") {
    return types;
  }
  const { nodeExtensions } = splitExtensions(extensions);
  return nodeExtensions
    .map((extension) => extension.name)
    .filter((type) => type !== "doc" && type !== "text");
};

/**
 * The block types the editor gives a unique `id`. The ONE list: the editor, its
 * read-only renderers and the server (whose git-sync writes must carry the
 * same ids, or opening a page would add them as the viewer's edit) all
 * configure `UniqueID` with it.
 */
export const UNIQUE_ID_TYPES = ["heading", "paragraph", "transclusionSource"];

export const UniqueID = TiptapUniqueID.extend({
  addOptions() {
    return {
      ...this.parent?.(),
      generateID: () => generateNodeId(),
    };
  },

  addStorage() {
    return {
      ...this.parent?.(),
      unsubscribeSynced: null,
    };
  },

  // #709 — local override of 3.20.4's `onCreate`, which with a collaboration
  // provider only subscribes to its "synced" and never unsubscribes. With warm
  // collab sessions the provider outlives the editor: an editor mounted on an
  // ALREADY synced provider would never get that event (its nodes would stay
  // without ids), and a destroyed editor would stay subscribed. So: create the
  // ids right away when the provider is already synced, otherwise subscribe and
  // keep the unsubscribe in storage (the extension is shared by the static and
  // the live editors; storage is per editor) for `onDestroy`. `createIds` is
  // the one from 3.20.4's dist.
  onCreate() {
    if (!this.options.updateDocument) {
      return;
    }
    const collaboration = this.editor.extensionManager.extensions.find(
      (ext) => ext.name === "collaboration",
    );
    const collaborationCaret = this.editor.extensionManager.extensions.find(
      (ext) => ext.name === "collaborationCaret",
    );
    const collab = [collaboration, collaborationCaret]
      .filter(Boolean)
      .find((ext) => ext?.options?.provider);
    const provider = collab?.options?.provider;
    const createIds = () => {
      const { view, state } = this.editor;
      const { tr, doc } = state;
      const types = resolveTypes(
        this.options.types,
        this.editor.extensionManager.extensions,
      );
      const { attributeName, generateID } = this.options;
      const nodesWithoutId = findChildren(doc, (node) => {
        return (
          types.includes(node.type.name) && node.attrs[attributeName] === null
        );
      });
      nodesWithoutId.forEach(({ node, pos }) => {
        tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          [attributeName]: generateID({ node, pos }),
        });
      });
      tr.setMeta("addToHistory", false);
      view.dispatch(tr);
      if (provider) {
        provider.off("synced", createIds);
      }
    };
    if (collaboration) {
      if (provider) {
        if (provider.isSynced) {
          createIds();
        } else {
          provider.on("synced", createIds);
          this.storage.unsubscribeSynced = () =>
            provider.off("synced", createIds);
        }
      }
    } else {
      return createIds();
    }
  },

  onDestroy() {
    this.storage.unsubscribeSynced?.();
  },
});
