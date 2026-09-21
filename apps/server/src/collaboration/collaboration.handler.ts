import { Injectable, Logger } from '@nestjs/common';
import { Hocuspocus, Document } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import {
  applyPmJsonToFragment,
  isEmptyParagraphDoc,
  prosemirrorNodeToYElement,
  tiptapExtensions,
} from './collaboration.util';
import { pageContentHash } from './content-hash.util';
import {
  removeYjsMarkByAttribute,
  replaceYjsMarkedText,
  setYjsMark,
  updateYjsMarkAttribute,
  YjsSelection,
} from './yjs.util';
import * as Y from 'yjs';
import { User } from '@docmost/db/types/entity.types';

export type CollabEventHandlers = ReturnType<
  CollaborationHandler['getHandlers']
>;

/**
 * #647 refinement B — result of the `readLiveContent` probe (the owner-side half
 * of the `readLiveIfLoaded` primitive #654 depends on).
 *  - `loaded:true`  → the document IS in this instance's memory and `content`/
 *    `hash` are the FULLY HYDRATED live doc (property 5). `hash` is coherent with
 *    `content` (both derived from the same `fromYdoc`).
 *  - `loaded:false` → the document is not loaded on this instance. The probe NEVER
 *    force-loads it (property 2) and NEVER claims ownership (property 3).
 * The `unreachable` case (owner exists but the probe timed out / errored) is
 * produced by the BRIDGE layer, not this handler.
 */
export type ReadLiveContentResult =
  | { loaded: true; content: any; hash: string }
  | { loaded: false };

/**
 * #647 §C — verdict of the server-side write-CAS (`replaceIfMatch`).
 *  - `applied:true`  → `baseHash` matched the authoritative live doc and the
 *    structural overwrite was applied; `newHash` is the post-write content hash.
 *  - `applied:false` (no `reason`) → `baseHash` did NOT match: a concurrent edit
 *    landed between the agent's read and this write. `currentHash` is the live
 *    hash to re-read against. No mutation happened → REST maps this to HTTP 409.
 *  - `applied:false` + `reason:'empty-replace-refused'` → §C/B4: the replacement
 *    would empty a non-empty page. Refused (fail-closed) rather than risking the
 *    store-side empty-guard rolling the write back into a hash/content desync with
 *    a poisoned `newHash`. REST maps this to 422.
 */
export type ReplaceIfMatchResult =
  | { applied: true; newHash: string }
  | { applied: false; currentHash: string; reason?: 'empty-replace-refused' };

@Injectable()
export class CollaborationHandler {
  private readonly logger = new Logger(CollaborationHandler.name);

  getHandlers(hocuspocus: Hocuspocus) {
    return {
      alterState: async (documentName: string, payload: { pageId: string }) => {
        // dummy
        // this.logger.log('Processing', documentName, payload);
        // await this.withYdocConnection(hocuspocus, documentName, {}, (doc) => {
        //   const fragment = doc.getXmlFragment('default');
        //});
      },
      setCommentMark: async (
        documentName: string,
        payload: {
          yjsSelection: YjsSelection;
          commentId: string;
          resolved: boolean;
          user: User;
        },
      ) => {
        const { yjsSelection, commentId, resolved, user } = payload;
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');
            setYjsMark(doc, fragment, yjsSelection, 'comment', {
              commentId,
              resolved,
            });
          },
        );
      },
      resolveCommentMark: async (
        documentName: string,
        payload: {
          commentId: string;
          resolved: boolean;
          user: User;
        },
      ) => {
        const { commentId, resolved, user } = payload;
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');
            updateYjsMarkAttribute(
              fragment,
              'comment',
              { name: 'commentId', value: commentId },
              { resolved },
            );
          },
        );
      },
      deleteCommentMark: async (
        documentName: string,
        payload: {
          commentId: string;
          user: User;
        },
      ) => {
        const { commentId, user } = payload;
        // Ephemeral suggestions (#329): when a suggestion-edit is dismissed or an
        // applied one has no replies, the comment is hard-deleted and its inline
        // anchor must vanish too. Mirror resolveCommentMark exactly, but instead
        // of flipping the mark's `resolved` attribute we STRIP the `comment` mark
        // entirely via removeYjsMarkByAttribute so no orphan highlight remains in
        // the collaborative document.
        //
        // Routing this through collaboration.gateway's handleYjsEvent means the
        // COLLAB_DISABLE_REDIS path invokes this handler directly (never a silent
        // no-op) and a missing live instance is a hard error — the same guarantee
        // applyCommentSuggestion/resolveCommentMark rely on.
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');
            removeYjsMarkByAttribute(
              fragment,
              'comment',
              'commentId',
              commentId,
            );
          },
        );
      },
      applyCommentSuggestion: async (
        documentName: string,
        payload: {
          commentId: string;
          expectedText: string;
          newText: string;
          user: User;
        },
      ): Promise<{ applied: boolean; currentText: string | null }> => {
        const { commentId, expectedText, newText, user } = payload;
        // Run the check-and-replace inside the owning instance's Y transaction so
        // the delete+insert are atomic. The verdict from replaceYjsMarkedText is
        // returned to the API-server caller (cross-process via the Redis bridge,
        // or locally when Redis is disabled — see collaboration.gateway.ts).
        return this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');
            return replaceYjsMarkedText(
              fragment,
              commentId,
              expectedText,
              newText,
            );
          },
        );
      },
      updatePageContent: async (
        documentName: string,
        payload: {
          prosemirrorJson: any;
          operation: string;
          user: User;
        },
      ) => {
        const { operation, user } = payload;
        const { prosemirrorJson } = payload;
        this.logger.debug('Updating page content via yjs', documentName);

        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');

            if (operation === 'replace') {
              if (fragment.length > 0) {
                fragment.delete(0, fragment.length);
              }

              const newDoc = TiptapTransformer.toYdoc(
                prosemirrorJson,
                'default',
                tiptapExtensions,
              );
              Y.applyUpdate(doc, Y.encodeStateAsUpdate(newDoc));
            } else {
              const newContent = prosemirrorJson.content || [];
              const yElements = newContent.map(prosemirrorNodeToYElement);
              const position = operation === 'prepend' ? 0 : fragment.length;
              fragment.insert(position, yElements);
            }
          },
        );
      },
      /**
       * #647 §C — server-side write-CAS (`replaceIfMatch`), the authoritative
       * compare-and-swap that closes the "agent reads H, human/another agent
       * edits, agent's full overwrite silently clobbers it" race.
       *
       * Routed to the document OWNER as a WRITE event (`handleYjsEvent` →
       * `redisSync.handleEvent`, 30s TTL): if the owner is unreachable the bridge
       * TIMES OUT and throws, so the caller fails CLOSED (retryable) — it never
       * falls back to comparing against a stale DB snapshot (which is exactly why
       * the compare here reads the LIVE `fromYdoc(doc)` inside the transaction and
       * NOT `getLiveContentPair`, whose `unreachable`→DB-reconstruct collapse
       * would let a write clobber an unreachable owner's newer state).
       *
       * Inside `connection.transact` (synchronous, atomic):
       *  1. hash the AUTHORITATIVE live doc (`fromYdoc`);
       *  2. `!== baseHash` → return `{applied:false, currentHash}`, NO mutation;
       *  3. B4 empty-guard → refuse an empty-over-non-empty replace;
       *  4. else apply via the STRUCTURAL diff (`applyPmJsonToFragment` /
       *     `updateYFragment`, NOT delete+recreate) so an idle human editor's
       *     cursor is preserved (#152), and return `{applied:true, newHash}`.
       *
       * B3 attribution: the connection context carries `{user, actor, aiChatId,
       * apiKeyId}` (not just `{user}` like the legacy `updatePageContent`), so the
       * debounced store stamps `lastUpdatedSource='agent'` and preserves the
       * `apiKeyId`/`aiChatId` of the write.
       */
      replaceIfMatch: async (
        documentName: string,
        payload: {
          prosemirrorJson: any;
          baseHash: string;
          user: User;
          actor?: string;
          aiChatId?: string | null;
          apiKeyId?: string | null;
        },
      ): Promise<ReplaceIfMatchResult> => {
        const { prosemirrorJson, baseHash, user, actor, aiChatId, apiKeyId } =
          payload;
        return this.withYdocConnection(
          hocuspocus,
          documentName,
          { user, actor, aiChatId, apiKeyId },
          (doc): ReplaceIfMatchResult => {
            const current = TiptapTransformer.fromYdoc(doc, 'default');
            const currentHash = pageContentHash(current);

            // (2) CAS: authoritative live hash must equal the agent's baseHash.
            if (currentHash !== baseHash) {
              return { applied: false, currentHash };
            }

            // (3) B4 empty-guard: an empty replacement over non-empty content
            // would be silently rolled back by the store-side empty-guard
            // (persistence.extension), leaving the broadcast/newHash out of sync
            // with the persisted row. Refuse it here (fail-closed) instead. An
            // empty-over-empty replace is a harmless no-op and is allowed to fall
            // through. `isEmptyParagraphDoc` is true for updatePageMarkdown("")
            // and false for updatePageJson({content:[]}) — same asymmetry the
            // store-guard sees.
            if (
              isEmptyParagraphDoc(prosemirrorJson) &&
              !isEmptyParagraphDoc(current)
            ) {
              return {
                applied: false,
                currentHash,
                reason: 'empty-replace-refused',
              };
            }

            // (4) Structural overwrite — preserves unchanged nodes' Yjs ids.
            applyPmJsonToFragment(doc, prosemirrorJson);
            const after = TiptapTransformer.fromYdoc(doc, 'default');
            return { applied: true, newHash: pageContentHash(after) };
          },
        );
      },
      /**
       * #647 refinement B — NON-CLAIMING, NON-FORCE-LOADING read of the live doc.
       *
       * The owner-side half of `readLiveIfLoaded` (#654's gating primitive). It
       * reads ONLY what is already hydrated in this instance's memory:
       *  - property 2 (no force-load): we consult `hocuspocus.documents` directly
       *    and NEVER call `openDirectConnection` (which would load from the DB);
       *  - property 3 (non-claiming): no lock is taken here — the bridge decides
       *    routing with a plain GET, and this local read touches no lock key;
       *  - property 5 (loaded ⇒ hydrated): a doc present in `documents` has already
       *    run `onLoadDocument` (synchronous `Y.applyUpdate`), so `fromYdoc` yields
       *    the fully hydrated live content, hashed coherently in the SAME pass.
       */
      readLiveContent: async (
        documentName: string,
      ): Promise<ReadLiveContentResult> => {
        const doc = hocuspocus.documents.get(documentName);
        if (!doc) {
          return { loaded: false };
        }
        const content = TiptapTransformer.fromYdoc(doc, 'default');
        return { loaded: true, content, hash: pageContentHash(content) };
      },
    };
  }

  async withYdocConnection<T>(
    hocuspocus: Hocuspocus,
    documentName: string,
    context: any = {},
    // `fn` MUST be synchronous: hocuspocus `connection.transact(fn)` runs fn
    // synchronously and does NOT await it, so any mutations after an `await`
    // inside fn would execute OUTSIDE the Yjs transaction and lose atomicity.
    fn: (doc: Document) => T,
  ): Promise<T> {
    const connection = await hocuspocus.openDirectConnection(
      documentName,
      context,
    );
    try {
      // hocuspocus `connection.transact(fn)` invokes fn(document) but does NOT
      // forward fn's return value, so we capture it in a closure and return it
      // after the transaction (and its storeDocument hooks) resolve.
      let result: T;
      await connection.transact((doc) => {
        result = fn(doc);
      });
      return result!;
    } finally {
      await connection.disconnect();
    }
  }
}
