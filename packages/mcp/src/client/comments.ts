// Auto-split from client.ts (issue #450). Mixin over the shared client context.
// Bodies are VERBATIM from the original DocmostClient; only the enclosing class
// changed to a mixin factory. See client/context.ts for the shared base.
import type { GConstructor, DocmostClientContext } from "./context.js";
import { assertFullUuid } from "./errors.js";
import {
  filterWorkspace,
  filterSpace,
  filterPage,
  filterComment,
  filterSearchResult,
} from "../lib/filters.js";
import { convertProseMirrorToMarkdown } from "../lib/markdown-converter.js";
import {
  updatePageContentRealtime,
  replacePageContent,
  markdownToProseMirror,
  markdownToProseMirrorCanonical,
  mutatePageContent,
  assertYjsEncodable,
  MutationResult,
} from "../lib/collaboration.js";
import {
  replaceNodeById,
  replaceNodeByIdWithMany,
  reassignCollidingBlockIds,
  deleteNodeById,
  assertUnambiguousMatch,
  insertNodeRelative,
  insertNodesRelative,
  blockPlainText,
  buildOutline,
  getNodeByRef,
  readTable,
  insertTableRow,
  deleteTableRow,
  updateTableCell,
  findInvalidNode,
} from "@docmost/prosemirror-markdown";
import {
  applyAnchorInDoc,
  countAnchorMatches,
  getAnchoredText,
  resolveAnchorSelection,
  selectionOnlyInMarkForbiddingBlock,
  normalizeForMatch,
  foldForMatch,
} from "../lib/comment-anchor.js";
import { closestBlockHint } from "../lib/text-normalize.js";
import {
  blockText,
  walk,
  getList,
  insertMarkerAfter,
  setCalloutRange,
  noteItem,
  mdToInlineNodes,
  commentsToFootnotes,
  canonicalizeFootnotes,
  insertInlineFootnote,
  mergeFootnoteDefinitions,
} from "../lib/transforms.js";

// Max concurrent per-page comment fetches in checkNewComments (#490). The scan is
// O(N) independent REST reads over the working set; running them one-at-a-time made
// a large space linear in round-trips. A small cap parallelizes without hammering
// the server (or exhausting sockets). 6 is a conservative middle of the 5–8 band.
const COMMENT_SCAN_CONCURRENCY = 6;

/**
 * Map `items` through `fn` with at most `limit` in flight, preserving INPUT ORDER
 * in the returned array. A tiny bounded pool (no p-limit dependency): `limit`
 * workers pull the next index off a shared cursor until the list is drained.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// Public method surface of CommentsMixin (issue #450) — a NAMED type so the factory
// return type is expressible in the emitted .d.ts (the anonymous mixin class
// carries the base's protected shared state, which would otherwise trip TS4094).
// Derived from the class below; `implements ICommentsMixin` fails to compile on drift.
export interface ICommentsMixin {
  listComments(pageId: string, includeResolved?: boolean): any;
  getComment(commentId: string): any;
  createComment(pageId: string, content: string, type?: "page" | "inline", selection?: string, parentCommentId?: string, suggestedText?: string): any;
  updateComment(commentId: string, content: string): any;
  deleteComment(commentId: string): any;
  resolveComment(commentId: string, resolved: boolean): any;
  checkNewComments(spaceId: string, since: string, parentPageId?: string): any;
}

export function CommentsMixin<TBase extends GConstructor<DocmostClientContext>>(Base: TBase): GConstructor<DocmostClientContext & ICommentsMixin> & TBase {
  abstract class CommentsMixin extends Base implements ICommentsMixin {
  // --- Comment methods (ported from upstream PR #3 by Max Nikitin) ---

  /**
   * Normalize a comment's `content` into a ProseMirror doc object before
   * markdown conversion. createComment/updateComment send content as a
   * JSON.stringify(...) STRING, and the server stores it as-is, so on read it
   * comes back as a string. convertProseMirrorToMarkdown returns "" for a
   * string, so parse it first (guarded — fall back to the raw value on any
   * parse failure so a non-JSON legacy value is still handled gracefully).
   */
  protected parseCommentContent(content: any): any {
    if (typeof content !== "string") return content;
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }

  /**
   * List comments on a page (cursor-paginated), content as markdown.
   *
   * DEFAULT (`includeResolved = false`) hides RESOLVED THREADS WHOLESALE so the
   * agent sees only active discussions: a top-level comment with `resolvedAt`
   * set AND every reply under it (a reply of a closed thread is part of the
   * closed thread) are dropped from `items`. `resolvedThreadsHidden` reports how
   * many resolved top-level threads were hidden so the agent can re-query with
   * `includeResolved: true` to see everything. Active threads always stay.
   *
   * Returns `{ items, resolvedThreadsHidden }` (NOT a bare array) — callers that
   * need the full feed (lossless export, transformPage, checkNewComments) pass
   * `includeResolved: true` and read `.items`.
   */
  async listComments(pageId: string, includeResolved = false) {
    await this.ensureAuthenticated();
    let allComments: any[] = [];
    let cursor: string | null = null;

    // Hard ceiling + immovable-cursor guard (mirrors paginateAll): if /comments
    // ever stops advancing the cursor (the exact #442 drift scenario) this loop
    // would otherwise spin forever accumulating duplicates.
    const MAX_PAGES = 50;
    let truncated = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      const payload: Record<string, any> = { pageId, limit: 100 };
      if (cursor) payload.cursor = cursor;

      const response = await this.client.post("/comments", payload);
      const data = response.data.data || response.data;
      const items = data.items || [];
      allComments = allComments.concat(items);

      // Advance strictly via the server-issued cursor. A missing nextCursor or a
      // cursor identical to the one we just sent means the end (or a server that
      // ignores our pagination param) — stop instead of re-fetching page one.
      const next: string | null = data.meta?.nextCursor || null;
      if (!next || next === cursor) break;
      cursor = next;

      // Reaching the ceiling with a still-advancing cursor means truncation.
      if (page === MAX_PAGES - 1) truncated = true;
    }

    if (truncated) {
      console.warn(
        `listComments: comments for "${pageId}" truncated at the ${MAX_PAGES}-page cap; more pages exist on the server`,
      );
    }

    const mapped = allComments.map((comment: any) => {
      const markdown = comment.content
        ? convertProseMirrorToMarkdown(
            this.parseCommentContent(comment.content),
          )
        : "";
      return filterComment(comment, markdown);
    });

    if (includeResolved) {
      return { items: mapped, resolvedThreadsHidden: 0 };
    }

    // Ids of RESOLVED top-level threads (a top-level comment has no
    // parentCommentId). A whole thread is hidden when its root is resolved.
    const resolvedRootIds = new Set(
      mapped
        .filter((c) => !c.parentCommentId && c.resolvedAt != null)
        .map((c) => c.id),
    );

    const items = mapped.filter((c) => {
      // Hide the resolved root itself and every reply anchored to it. A reply's
      // own resolvedAt is irrelevant — its membership follows the parent thread.
      // ASSUMPTION: Docmost's comment model is FLAT — a reply's parentCommentId
      // always points at the thread ROOT (no reply-of-reply nesting), so a single
      // level of parent lookup covers a whole thread. If nested replies are ever
      // introduced, a deep reply of a resolved thread would need a root-walk here.
      if (!c.parentCommentId) return !resolvedRootIds.has(c.id);
      return !resolvedRootIds.has(c.parentCommentId);
    });

    return { items, resolvedThreadsHidden: resolvedRootIds.size };
  }


  async getComment(commentId: string) {
    // Fail fast (#436): reject a truncated id before any network call.
    assertFullUuid("get_comment", "commentId", commentId);
    await this.ensureAuthenticated();
    const response = await this.client.post("/comments/info", { commentId });
    const comment = response.data.data || response.data;
    const markdown = comment.content
      ? convertProseMirrorToMarkdown(this.parseCommentContent(comment.content))
      : "";
    return {
      data: filterComment(comment, markdown),
      success: true,
    };
  }

  /** Plain text of each TOP-LEVEL block of `doc`, for anchor-failure hints. */
  protected topLevelBlockTexts(doc: any): string[] {
    const content = doc && Array.isArray(doc.content) ? doc.content : [];
    return content
      .map((b: any) => blockPlainText(b))
      .filter((t: string) => t.length > 0);
  }

  /**
   * True when per-block anchoring failed but the (normalized) selection DOES
   * appear in the blocks' joined plain text — i.e. it straddles a block
   * boundary. Blocks are joined with a newline (collapsed to one space by
   * normalizeForMatch) so a selection whose parts are separated by a paragraph
   * break still matches. Callers only reach here after single-block anchoring
   * (incl. the markdown-strip fallback) has already failed.
   *
   * Checked in BOTH the pass-1 (normalizeForMatch) and fold (foldForMatch) tier
   * spaces (#658): a selection that straddles a block boundary only once its
   * invisible characters are folded is still diagnosed as multi-block, instead
   * of degrading to a "closest block" hint in exactly the target case.
   */
  protected selectionSpansMultipleBlocks(
    blockTexts: string[],
    selection: string,
  ): boolean {
    for (const normalizer of [normalizeForMatch, foldForMatch]) {
      const normSel = normalizer(selection).norm.trim();
      if (normSel.length === 0) continue;
      const joined = normalizer(blockTexts.join("\n")).norm;
      if (joined.indexOf(normSel) !== -1) return true;
    }
    return false;
  }

  /**
   * Build the actionable error for a createComment anchor MISS, porting
   * editPageText's self-correction affordances: an explicit "spans multiple
   * blocks" message when the selection straddles a block boundary, otherwise a
   * "closest block text" hint quoting the block that holds the selection's
   * longest token. `live` switches the wording between the pre-check (reading the
   * persisted page) and the post-create live-anchor failure (which rolls back).
   */
  protected anchorNotFoundError(
    doc: any,
    selection: string,
    live: boolean,
  ): Error {
    const blockTexts = this.topLevelBlockTexts(doc);
    const rolled = live ? " The comment was rolled back." : "";
    // Checked FIRST: the selection may well be contiguous document text, just
    // in a place where the schema forbids the comment mark (a codeBlock) — the
    // spans-multiple-blocks / closest-block hints would send the agent chasing
    // a selection problem that does not exist.
    if (selectionOnlyInMarkForbiddingBlock(doc, selection)) {
      return new Error(
        "createComment: the selection text occurs only inside a code block; " +
          "inline comments cannot anchor to code block content (the editor " +
          "schema forbids marks there). Anchor the comment on the prose " +
          "paragraph next to the code block instead." +
          rolled,
      );
    }
    if (this.selectionSpansMultipleBlocks(blockTexts, selection)) {
      return new Error(
        "createComment: the selection spans multiple blocks; anchor on a " +
          "contiguous fragment within a SINGLE paragraph/block (<=250 chars)." +
          rolled,
      );
    }
    const where = live ? "in the live document" : "in the page";
    return new Error(
      `createComment: could not find the selection text ${where} to anchor ` +
        "the comment. Provide the EXACT contiguous text from a single " +
        "paragraph/block (<=250 chars)." +
        closestBlockHint(blockTexts, selection) +
        rolled,
    );
  }

  /**
   * Create an inline comment anchored to its `selection` text, or a reply.
   *
   * Top-level comments (no `parentCommentId`) are ALWAYS inline and MUST carry a
   * `selection`: the `type` argument is kept for interface compatibility but the
   * effective type is coerced to "inline". The selection has to anchor in the
   * document; if it cannot, the comment is rolled back and an error is thrown so
   * the caller is forced to supply a proper inline selection rather than leaving
   * an orphan, unanchored comment behind. Replies (parentCommentId set) inherit
   * their parent's anchor: they take NO selection and are not anchored.
   */
  async createComment(
    pageId: string,
    content: string,
    type: "page" | "inline" = "page",
    selection?: string,
    parentCommentId?: string,
    suggestedText?: string,
  ) {
    // Fail fast (#436): a provided parent id must be a full UUID before any
    // network call. Validate only when truthy — a falsy parentCommentId means
    // "top-level comment" (mirrors the isReply computation below), not a reply.
    if (parentCommentId) {
      assertFullUuid("createComment", "parentCommentId", parentCommentId);
    }
    await this.ensureAuthenticated();

    const isReply = !!parentCommentId;
    const hasSuggestion =
      suggestedText !== undefined && suggestedText !== null;
    // Defense in depth mirroring the server DTO/service: a suggested edit rewrites
    // the exact anchored text, so it is only meaningful on a top-level inline
    // comment that carries a selection.
    if (hasSuggestion) {
      if (isReply) {
        throw new Error(
          "createComment: a suggested edit (suggestedText) cannot be attached to a reply; it applies only to a top-level inline comment.",
        );
      }
      if (!selection || !selection.trim()) {
        throw new Error(
          "createComment: a suggested edit (suggestedText) requires a 'selection' to anchor and rewrite.",
        );
      }
    }
    // Only top-level comments are inline-anchored, so they are stored as
    // "inline". Replies carry no inline selection, so they keep the historical
    // general ("page") type — both backward-compatible and semantically correct.
    // The `type` argument is kept for interface compatibility; createComment
    // normalizes the effective type internally, so callers may pass "inline".
    const effectiveType: "page" | "inline" = isReply ? "page" : "inline";
    if (!isReply && (!selection || !selection.trim())) {
      throw new Error(
        "createComment: an inline 'selection' (exact text to anchor on) is required for a top-level comment",
      );
    }

    // For a SUGGESTION, the value we store as the comment's `selection` must be
    // the RAW document substring the mark lands on (typographic quotes/dashes,
    // nbsp, collapsed whitespace), NOT the agent's ASCII input. The anchor is
    // placed via normalization, so when the doc was auto-converted to
    // typographic the raw substring differs from the agent input; apply-time
    // compares the stored selection to the marked doc text STRICTLY, so storing
    // the raw substring is what makes "Apply" succeed instead of a spurious 409.
    // Captured in the pre-check below (which already reads the page) and used as
    // payload.selection. Ordinary comments keep sending the raw agent selection.
    let anchoredSelection: string | null = null;
    // Set when the anchor matched only after stripping markdown from the
    // selection (the strip fallback); surfaced as a soft warning like
    // editPageText does, so a stale-markdown selection is flagged.
    let anchorNormalized = false;

    // For a top-level comment, fail BEFORE creating anything when the selection
    // is not present in the persisted document — this avoids leaving an orphan
    // comment + notification behind. A read failure (network) is non-fatal: the
    // live anchor step below still enforces the anchoring invariant.
    if (!isReply && selection) {
      try {
        const page = await this.getPageJson(pageId);
        if (hasSuggestion) {
          // A suggestion's anchor MUST be unambiguous: applying it rewrites the
          // exact anchored text, and ordinary anchoring silently takes the first
          // occurrence, so 0 matches -> not found and >=2 -> ambiguous, both
          // rejected BEFORE creating the comment.
          const matches = countAnchorMatches(page.content, selection);
          if (matches === 0) {
            throw this.anchorNotFoundError(page.content, selection, false);
          }
          if (matches >= 2) {
            throw new Error(
              `createComment: the suggestion's selection is ambiguous — it occurs ${matches} times in the page. ` +
                "A suggested edit must anchor to a UNIQUE location; expand the selection with surrounding context " +
                "(still <=250 chars) so it appears exactly once.",
            );
          }
          // Exactly one match: capture the RAW anchored substring to store as the
          // comment selection (so apply-time equality holds). If this returns
          // null despite countAnchorMatches===1 (shouldn't happen), fall back to
          // the raw agent selection below rather than crash.
          anchoredSelection = getAnchoredText(page.content, selection);
          anchorNormalized = resolveAnchorSelection(
            page.content,
            selection,
          ).normalized;
        } else {
          const resolved = resolveAnchorSelection(page.content, selection);
          if (!resolved.found) {
            throw this.anchorNotFoundError(page.content, selection, false);
          }
          anchorNormalized = resolved.normalized;
        }
      } catch (e) {
        // Rethrow our own "not found"/"ambiguous"/"spans multiple blocks" errors;
        // swallow read/network errors so the live anchor step can still try (and
        // enforce) anchoring.
        if (
          e instanceof Error &&
          (e.message.startsWith("createComment: could not find the selection") ||
            e.message.startsWith(
              "createComment: the selection spans multiple blocks",
            ) ||
            e.message.startsWith(
              "createComment: the selection text occurs only inside a code block",
            ) ||
            e.message.startsWith(
              "createComment: the suggestion's selection is ambiguous",
            ))
        ) {
          throw e;
        }
        if (process.env.DEBUG) {
          console.error(
            "Pre-check getPageJson failed; deferring to live anchor step:",
            e,
          );
        }
      }
    }

    // Convert through the full Docmost schema. Deliberately the NON-canonicalizing
    // variant: a comment body may carry a footnote definition with no matching
    // reference, and canonicalization would drop it (data loss). See
    // markdownToProseMirror vs markdownToProseMirrorCanonical.
    const jsonContent = await markdownToProseMirror(content);
    const payload: Record<string, any> = {
      pageId,
      content: JSON.stringify(jsonContent),
      type: effectiveType,
    };
    // For a suggestion, store the RAW anchored substring (anchoredSelection) so
    // the stored selection === the text under the mark === apply-time
    // expectedText. Ordinary comments (and the null fallback) keep the raw
    // agent selection — their selection is only display/anchor and never used
    // by apply, so their behavior is unchanged.
    if (!isReply && selection)
      payload.selection = anchoredSelection ?? selection;
    if (parentCommentId) payload.parentCommentId = parentCommentId;
    // Only a top-level inline comment (with a selection) may carry a suggestion.
    if (!isReply && selection && hasSuggestion) {
      payload.suggestedText = suggestedText;
    }

    const response = await this.client.post("/comments/create", payload);
    const comment = response.data.data || response.data;
    const markdown = comment.content
      ? convertProseMirrorToMarkdown(this.parseCommentContent(comment.content))
      : content;
    const result: any = {
      data: filterComment(comment, markdown),
      success: true,
    };

    // Replies inherit the parent's anchor: no selection, no anchoring.
    if (isReply) {
      return result;
    }

    // Anchor the comment in the document. The /comments/create API records the
    // comment + its `selection` text, but it does NOT insert the comment MARK
    // into the page content, so without this the inline comment has no
    // highlight/anchor and is not clickable. If anchoring fails the comment is
    // rolled back (deleted) and an error is thrown — never an orphan comment.
    const newCommentId: string = comment.id;
    // Guard: a create response without an id would mean writing a comment mark
    // with commentId: undefined and a later delete of a falsy id. We have no id
    // to roll back here (nothing was created with an id), so just fail loudly.
    if (!newCommentId) {
      throw new Error(
        "createComment: the server returned no comment id, so the comment could not be anchored",
      );
    }
    let anchored = false;
    // Set inside the transform when a suggestion's live anchor is ambiguous
    // (>=2 occurrences), so the rollback path can surface the right error.
    let ambiguousInLiveDoc = false;
    // Captured inside the transform on a not-found abort, so the rollback path
    // can surface the closest-block / spans-multiple-blocks hint built from the
    // LIVE document (the pre-check page is not in scope there).
    let liveNotFoundError: Error | null = null;
    // #496: the RAW substring the mark actually covers in the LIVE doc. The
    // stored selection (payload.selection) came from a DEBOUNCED REST snapshot,
    // which can differ from the live doc — and apply compares the marked live
    // text to the stored selection strictly, so a stale snapshot 409s on EVERY
    // apply. Captured here (same doc version the mark is set in) and synced below.
    let liveAnchoredSelection: string | null = null;
    try {
      const collabToken = await this.getCollabTokenWithReauth();
      // Open the collab doc by the canonical UUID, never the slugId (#260). The
      // /comments/create REST call above keeps the agent-supplied id.
      const pageUuid = await this.resolvePageId(pageId);
      // Route through the mutatePage seam (not the free function) so this
      // wrapper's uniqueness gate + rollback can be unit-tested without a live
      // Hocuspocus collab socket.
      const mutation = await this.mutatePage(
        pageUuid,
        collabToken,
        this.apiUrl,
        (liveDoc) => {
          const doc =
            liveDoc && liveDoc.type === "doc"
              ? liveDoc
              : { type: "doc", content: [] };
          if (hasSuggestion) {
            // Authoritative uniqueness check against the LIVE document: a
            // suggestion must anchor to EXACTLY ONE occurrence, otherwise
            // "Apply" would rewrite the wrong/ambiguous text. If the live doc
            // no longer has exactly one occurrence (it changed since the
            // pre-check), abort so the just-created comment is rolled back
            // rather than mis-anchored to the first occurrence.
            const liveCount = countAnchorMatches(doc, selection as string);
            if (liveCount !== 1) {
              ambiguousInLiveDoc = liveCount >= 2;
              if (liveCount === 0) {
                liveNotFoundError = this.anchorNotFoundError(
                  doc,
                  selection as string,
                  true,
                );
              }
              return null;
            }
          }
          if (applyAnchorInDoc(doc, selection as string, newCommentId)) {
            anchored = true;
            // For a suggestion, re-read the exact substring now under the mark
            // (the mark is an attribute, so it does not change the raw text) to
            // sync as the stored expectedText after the mutation resolves.
            if (hasSuggestion) {
              liveAnchoredSelection = getAnchoredText(doc, selection as string);
            }
            return doc;
          }
          // Selection text not found in the LIVE document: abort the write. The
          // rollback + throw below turns this into a hard error.
          liveNotFoundError = this.anchorNotFoundError(
            doc,
            selection as string,
            true,
          );
          return null;
        },
      );
      result.verify = mutation.verify;
    } catch (e) {
      // The comment record already exists; roll it back so we never leave an
      // orphan, then rethrow the original anchoring error.
      await this.safeDeleteComment(newCommentId);
      throw e;
    }

    if (!anchored) {
      // Mutation aborted because the selection was not found (or, for a
      // suggestion, was ambiguous) in the live document. Roll back the comment
      // and surface a hard error.
      await this.safeDeleteComment(newCommentId);
      if (ambiguousInLiveDoc) {
        throw new Error(
          "createComment: the suggestion's selection is ambiguous in the live document (multiple occurrences); the comment was rolled back. Expand the selection with surrounding context so it is unique.",
        );
      }
      throw (
        liveNotFoundError ??
        new Error(
          "createComment: failed to anchor the comment (selection not found in the live document); the comment was rolled back",
        )
      );
    }

    // #496: sync the stored selection (== apply-time expectedText) to the RAW
    // substring the mark actually covers in the LIVE doc when it diverged from
    // the debounced REST snapshot we stored at create time. Without this, apply
    // strictly compares the marked live text to a stale stored selection and
    // 409s every time. Best-effort: the comment is already correctly anchored, so
    // a resync failure must NOT roll it back — it only risks a later apply 409,
    // which we surface as a soft warning.
    if (
      hasSuggestion &&
      liveAnchoredSelection != null &&
      liveAnchoredSelection !== payload.selection
    ) {
      try {
        await this.client.post("/comments/resync-suggestion-anchor", {
          commentId: newCommentId,
          selection: liveAnchoredSelection,
        });
        // Reflect the corrected anchor in the returned comment.
        if (result.data) result.data.selection = liveAnchoredSelection;
      } catch (e) {
        if (process.env.DEBUG) {
          console.error("Failed to resync suggestion anchor:", e);
        }
        result.warning =
          "The suggestion was anchored, but its stored selection could not be " +
          "synced to the live document; applying it may report a conflict if the " +
          "text changed. Re-create the suggestion if Apply fails.";
      }
    }

    // Soft warning (like editPageText): the selection only matched after
    // stripping markdown, so the caller likely quoted a styled fragment.
    if (anchorNormalized) {
      result.warning =
        "The selection matched only after stripping markdown syntax; the comment " +
        "was anchored on the document's plain text. Copy the selection verbatim " +
        "from getPage / searchInPage output to avoid this.";
    }

    result.anchored = true;
    return result;
  }

  /**
   * Best-effort rollback of a just-created comment. Swallows any delete failure
   * (logging under DEBUG) so a failed cleanup never masks the original error.
   */
  protected async safeDeleteComment(commentId: string): Promise<void> {
    // Defense in depth: never call the delete API with a falsy id — there is
    // nothing to roll back, and deleteComment(undefined) would hit a bad route.
    if (!commentId) return;
    try {
      await this.deleteComment(commentId);
    } catch (delErr) {
      if (process.env.DEBUG) {
        console.error(
          "Failed to roll back comment after anchoring error:",
          delErr,
        );
      }
    }
  }


  async updateComment(commentId: string, content: string) {
    // Fail fast (#436): reject a truncated id before any network call.
    assertFullUuid("updateComment", "commentId", commentId);
    await this.ensureAuthenticated();
    // NON-canonicalizing on purpose (comment body — see createComment).
    const jsonContent = await markdownToProseMirror(content);
    await this.client.post("/comments/update", {
      commentId,
      content: JSON.stringify(jsonContent),
    });
    return {
      success: true,
      commentId,
      message: "Comment updated successfully.",
    };
  }


  async deleteComment(commentId: string) {
    // Fail fast (#436): reject a truncated id before any network call.
    assertFullUuid("deleteComment", "commentId", commentId);
    await this.ensureAuthenticated();
    return this.client
      .post("/comments/delete", { commentId })
      .then((res) => res.data);
  }

  /**
   * Resolve or reopen a top-level comment thread (reversible — `resolved`
   * toggles the state). Only top-level comments can be resolved; the server
   * rejects resolving a reply. Hits POST /comments/resolve.
   */
  async resolveComment(commentId: string, resolved: boolean) {
    // Fail fast (#436): reject a truncated id before any network call.
    assertFullUuid("resolveComment", "commentId", commentId);
    await this.ensureAuthenticated();
    const response = await this.client.post("/comments/resolve", {
      commentId,
      resolved,
    });
    const comment = response.data?.data ?? response.data;
    return {
      success: true,
      commentId,
      resolved,
      comment,
    };
  }

  /**
   * Check for new comments across pages in a space (optionally scoped to a
   * subtree): pages updated after `since` are scanned and their comments
   * filtered by createdAt > since.
   */
  async checkNewComments(
    spaceId: string,
    since: string,
    parentPageId?: string,
  ) {
    await this.ensureAuthenticated();

    const sinceDate = new Date(since);

    // Reject an unparseable `since`: comparing against an Invalid Date silently
    // yields zero new comments (every `>` against NaN is false), which would
    // mask a malformed input as "nothing new" instead of erroring.
    if (Number.isNaN(sinceDate.getTime())) {
      throw new Error(
        `checkNewComments: invalid "since" date "${since}"; expected an ISO-8601 timestamp`,
      );
    }

    // 1. Enumerate the FULL set of pages in scope via the page tree (a complete
    // page index), NOT the bounded "/pages/recent" feed which caps at ~5000
    // recent items and silently misses comments on older pages.
    //
    // Subtree scope: when parentPageId is given, the scope is that page ITSELF
    // plus every descendant. Otherwise the scope is the whole space (all roots
    // and their descendants).
    //
    // NOTE: do NOT pre-filter by page.updatedAt — creating a comment does not
    // bump it (verified on a live server), so such a filter silently misses
    // comments on pages that were not otherwise edited. The complete tree walk
    // already restricts the scope correctly, so no recent-feed allow-list is
    // needed any more.
    //
    // The subtree scope (parentPageId given) already INCLUDES the root node
    // itself: /pages/tree seeds getPageAndDescendants with id = parentPageId, so
    // no separate getPageRaw fetch for the parent is needed.
    // #534: the enumerateSpacePages seed (`/pages/tree`) 404s for a bad or
    // inaccessible spaceId; wrap it so that 404 becomes an actionable "spaceId
    // not accessible" hint instead of the opaque "Space permissions not found".
    // Only the whole enumeration is wrapped (the only 404 source here) — see the
    // wrap-allowlist invariant on withSpaceAccessDiagnostics.
    const { pages: pagesInScope, truncated } =
      await this.withSpaceAccessDiagnostics(spaceId, "checkNewComments", () =>
        this.enumerateSpacePages(spaceId, parentPageId),
      );

    // 2. Fetch comments for each page, keep ones created after since. Runs with
    // bounded concurrency (#490) instead of one-at-a-time — the per-page reads are
    // independent, so a large working set no longer costs O(N) serial round-trips.
    // Order is preserved (mapWithConcurrency keeps input order), so the output is
    // deterministic regardless of which fetch finishes first.
    const perPage = await mapWithConcurrency(
      pagesInScope,
      COMMENT_SCAN_CONCURRENCY,
      async (page: any) => {
        try {
          // Full feed (incl. resolved): a "new comments since" scan reports all
          // recent activity; the active-only filter is scoped to listComments.
          const comments = (await this.listComments(page.id, true)).items;
          const newComments = comments.filter(
            (c: any) => new Date(c.createdAt) > sinceDate,
          );
          return newComments.length > 0
            ? { pageId: page.id, pageTitle: page.title, comments: newComments }
            : null;
        } catch (e: any) {
          // Skip pages with errors (e.g. deleted between calls)
          return null;
        }
      },
    );
    const results: any[] = perPage.filter((r): r is any => r !== null);

    const totalNewComments = results.reduce(
      (sum, r) => sum + r.comments.length,
      0,
    );

    // `truncated` is reported by enumerateSpacePages: it is true ONLY when the
    // stdio fallback BFS hit its node cap. The primary /pages/tree path is
    // uncapped, so a space with legitimately many pages is not falsely flagged.
    return {
      since,
      scope: parentPageId ? `subtree of ${parentPageId}` : `space ${spaceId}`,
      checkedPages: pagesInScope.length,
      pagesWithNewComments: results.length,
      totalNewComments,
      truncated,
      comments: results,
    };
  }

  // --- Image upload / embedding ---

  /** Map a Content-Type string to a supported MIME type, or null if unsupported. */
  }
  return CommentsMixin;
}
