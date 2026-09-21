import { Extension } from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { HocuspocusProvider } from "@hocuspocus/provider";

/**
 * Stateless message type sent to the server when a user deliberately clears a
 * page to empty. Kept in one place so the client emitter and the server
 * consumer (PersistenceExtension.onStateless) agree on the wire format.
 */
export const INTENTIONAL_CLEAR_MESSAGE_TYPE = "intentional-clear";

export interface IntentionalClearOptions {
  /** The collab provider used to send the stateless clear signal. */
  provider: HocuspocusProvider | null;
}

/**
 * A "document is empty" check that mirrors the server's `isEmptyParagraphDoc`
 * (collaboration.util.ts): exactly one top-level paragraph with no inline
 * content. After a select-all + delete TipTap leaves precisely this shape, so
 * matching it here keeps the client signal aligned with the server guard that
 * consumes it.
 */
function isEmptyParagraphDoc(doc: PMNode): boolean {
  if (doc.childCount !== 1) return false;
  const child = doc.firstChild;
  return (
    child !== null &&
    child !== undefined &&
    child.type.name === "paragraph" &&
    child.content.size === 0
  );
}

/**
 * #251 — intentional-clear signal.
 *
 * The server's #248 store-side empty-guard unconditionally refuses to overwrite
 * non-empty persisted content with an empty document, because a momentarily
 * empty live Y.Doc (a glitch, a bad merge, an emptying transclusion) is
 * indistinguishable from a real clear *at the store layer*. That protection is
 * correct, but it also blocks a user who genuinely wants to empty the page.
 *
 * This extension supplies the missing distinction. It watches LOCAL, user-driven
 * transactions and, the moment one reduces a non-empty document to the empty
 * single-paragraph shape, it sends a hocuspocus stateless message to the server.
 * The server records a short-lived, single-use "intentional clear pending" flag
 * for this document that the next (debounced) onStoreDocument consumes to let
 * that one empty write through the guard.
 *
 * What counts as an intentional clear (precise definition):
 *  - the transaction actually changed the document (`docChanged`), AND
 *  - it is a LOCAL user edit, not a remote collab application — remote y-sync
 *    transactions are tagged and filtered out via `isChangeOrigin`, so an
 *    emptiness that arrives from another client / a merge never emits a signal,
 *    AND
 *  - the document was non-empty before the transaction and is the empty
 *    single-paragraph doc after it.
 *
 * This is exactly the select-all + Delete / Backspace (or any local command that
 * empties the doc, e.g. clearContent) keystroke path. A transient/programmatic
 * empty serialization that the server might see on the wire does NOT come with
 * this signal, so the guard still blocks it.
 */
export const IntentionalClear = Extension.create<IntentionalClearOptions>({
  name: "intentionalClear",

  addOptions() {
    return {
      provider: null,
    };
  },

  onTransaction({ transaction }) {
    if (!transaction.docChanged) return;
    // Only react to local user edits. Remote collaboration steps (and other
    // y-sync-applied changes) carry the change origin and must never be treated
    // as an intentional clear, otherwise a remote/merge-induced emptiness would
    // punch through the server guard.
    if (isChangeOrigin(transaction)) return;

    const becameEmpty =
      !isEmptyParagraphDoc(transaction.before) &&
      isEmptyParagraphDoc(transaction.doc);
    if (!becameEmpty) return;

    // The server reads the originating document from the connection, so the
    // payload only needs to declare intent — it cannot target another document.
    this.options.provider?.sendStateless(
      JSON.stringify({ type: INTENTIONAL_CLEAR_MESSAGE_TYPE }),
    );
  },
});
