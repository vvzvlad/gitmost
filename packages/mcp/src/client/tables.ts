// Auto-split from client.ts (issue #450). Mixin over the shared client context.
// Bodies are VERBATIM from the original DocmostClient; only the enclosing class
// changed to a mixin factory. See client/context.ts for the shared base.
import type { GConstructor, DocmostClientContext } from "./context.js";
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
import { withPageLock, isUuid } from "../lib/page-lock.js";
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

// Public method surface of TablesMixin (issue #450) — a NAMED type so the factory
// return type is expressible in the emitted .d.ts (the anonymous mixin class
// carries the base's protected shared state, which would otherwise trip TS4094).
// Derived from the class below; `implements ITablesMixin` fails to compile on drift.
export interface ITablesMixin {
  insertFootnote(pageId: string, anchorText: string, text: string): any;
  tableInsertRow(pageId: string, tableRef: string, cells: string[], index?: number): any;
  tableDeleteRow(pageId: string, tableRef: string, index: number): any;
  tableUpdateCell(pageId: string, tableRef: string, row: number, col: number, text: string): any;
}

export function TablesMixin<TBase extends GConstructor<DocmostClientContext>>(Base: TBase): GConstructor<DocmostClientContext & ITablesMixin> & TBase {
  abstract class TablesMixin extends Base implements ITablesMixin {
  /**
   * AUTHOR-INLINE footnote insertion. The agent supplies only WHERE
   * (`anchorText`, a snippet of body text to attach the marker after) and WHAT
   * (`text`, the footnote content as markdown). Numbering and the bottom
   * `footnotesList` are derived deterministically server-side
   * (`insertInlineFootnote` -> `canonicalizeFootnotes`): the agent never sees,
   * assigns, or edits a footnote number or the list, so it CANNOT desync.
   *
   * Content DEDUP: when an existing definition has the same content, its id is
   * reused (one number, one definition, several references). The write is atomic
   * via `mutatePageContent` (single-writer, page-locked); if the anchor text is
   * not found the transform aborts with a clear error and no write happens.
   */
  async insertFootnote(pageId: string, anchorText: string, text: string) {
    await this.ensureAuthenticated();
    if (!anchorText || !anchorText.trim()) {
      throw new Error("insertFootnote: anchorText is required");
    }
    if (text == null || `${text}`.trim() === "") {
      throw new Error("insertFootnote: text is required");
    }
    const collabToken = await this.getCollabTokenWithReauth();
    // Open the collab doc by the canonical UUID, never the slugId (#260).
    const pageUuid = await this.resolvePageId(pageId);
    let result: { footnoteId: string; reused: boolean } | null = null;
    const mutation = await this.mutatePage(
      pageUuid,
      collabToken,
      this.apiUrl,
      (liveDoc: any) => {
        const r = insertInlineFootnote(liveDoc, { anchorText, text });
        if (!r.inserted) {
          // Abort the page-locked write by throwing: mutatePageContent does not
          // persist when the transform throws, so a missing anchor leaves the
          // page untouched (no partial write).
          throw new Error(
            `insertFootnote: anchor text not found: ${JSON.stringify(
              anchorText.slice(0, 80),
            )}`,
          );
        }
        result = { footnoteId: r.footnoteId, reused: r.reused };
        return r.doc;
      },
    );
    // The not-found path throws inside the transform (aborting mutatePage), so by
    // here `result` is always set.
    const r = result!;
    return {
      success: true,
      modified: true,
      pageId,
      footnoteId: r.footnoteId,
      reused: r.reused,
      message: r.reused
        ? "Footnote inserted (reused an existing same-content definition)."
        : "Footnote inserted.",
      verify: mutation.verify,
    };
  }

  /**
   * Page-locked write seam over collaboration.mutatePageContent. Production just
   * delegates; it exists as an overridable method so the insertFootnote wrapper
   * (transform abort-on-not-found + response shaping) can be unit-tested without
   * standing up a live Hocuspocus collab socket.
   *
   * SELF-RESOLVES the pageId to the canonical UUID (issue #449, "resolve-then-
   * lock"): every write must lock and key its CollabSession by the UUID, never a
   * raw slugId (#260). resolvePageId is cached/idempotent, so a caller that
   * already resolved pays no extra round-trip; centralizing it here means a
   * caller that reaches this seam with a raw slugId still locks correctly instead
   * of silently splitting the mutex key. withPageLock also asserts the key is a
   * UUID as a hard backstop.
   */

  /**
   * Insert a row of plain-text cells into a table on the LIVE collab document.
   * `tableRef` is `#<index>` or a block id inside the target table. `cells` is
   * padded to the table's column count (more cells than columns throws); `index`
   * is a 0-based insert position (omit/out-of-range to append). Throws when no
   * table resolves for the reference.
   */
  async tableInsertRow(
    pageId: string,
    tableRef: string,
    cells: string[],
    index?: number,
  ) {
    await this.ensureAuthenticated();
    const collabToken = await this.getCollabTokenWithReauth();
    // Open the collab doc by the canonical UUID, never the slugId (#260).
    const pageUuid = await this.resolvePageId(pageId);

    // Track insertion in an outer var, reset per-transform, so a collab retry
    // recomputes it cleanly (mirrors insertNode's pattern).
    let inserted = false;
    const mutation = await mutatePageContent(
      pageUuid,
      collabToken,
      this.apiUrl,
      (liveDoc) => {
        inserted = false;
        const { doc: nd, inserted: ins } = insertTableRow(
          liveDoc,
          tableRef,
          cells,
          index,
        );
        inserted = ins;
        if (!inserted) return null; // table not found -> skip the write entirely
        return nd;
      },
    );
    // #654 — arm read-your-own-writes (no-op when nothing changed).
    this.rememberWrite(pageUuid, mutation.verify);

    if (!inserted) {
      throw new Error(
        `tableInsertRow: no table found for "${tableRef}" on page ${pageId} (use "#<index>" from getOutline, or a block id inside the table)`,
      );
    }
    return {
      success: true,
      table: tableRef,
      inserted: true,
      verify: mutation.verify,
    };
  }

  /**
   * Delete the row at 0-based `index` from a table on the LIVE collab document.
   * `tableRef` is `#<index>` or a block id inside the target table. The helper's
   * out-of-range and last-row errors propagate; a missing table throws here.
   */
  async tableDeleteRow(pageId: string, tableRef: string, index: number) {
    await this.ensureAuthenticated();
    const collabToken = await this.getCollabTokenWithReauth();
    // Open the collab doc by the canonical UUID, never the slugId (#260).
    const pageUuid = await this.resolvePageId(pageId);

    let deleted = false;
    const mutation = await mutatePageContent(
      pageUuid,
      collabToken,
      this.apiUrl,
      (liveDoc) => {
        deleted = false;
        const { doc: nd, deleted: del } = deleteTableRow(
          liveDoc,
          tableRef,
          index,
        );
        deleted = del;
        if (!deleted) return null; // table not found -> skip the write entirely
        return nd;
      },
    );
    // #654 — arm read-your-own-writes (no-op when nothing changed).
    this.rememberWrite(pageUuid, mutation.verify);

    if (!deleted) {
      throw new Error(
        `tableDeleteRow: no table found for "${tableRef}" on page ${pageId} (use "#<index>" from getOutline, or a block id inside the table)`,
      );
    }
    return {
      success: true,
      table: tableRef,
      deleted: true,
      verify: mutation.verify,
    };
  }

  /**
   * Set the plain-text content of cell `[row, col]` (0-based) in a table on the
   * LIVE collab document, replacing the cell's content with a single text
   * paragraph (the cell's first-paragraph id is preserved). `tableRef` is
   * `#<index>` or a block id inside the target table. The helper's out-of-range
   * error propagates; a missing table throws here.
   */
  async tableUpdateCell(
    pageId: string,
    tableRef: string,
    row: number,
    col: number,
    text: string,
  ) {
    await this.ensureAuthenticated();
    const collabToken = await this.getCollabTokenWithReauth();
    // Open the collab doc by the canonical UUID, never the slugId (#260).
    const pageUuid = await this.resolvePageId(pageId);

    let updated = false;
    const mutation = await mutatePageContent(
      pageUuid,
      collabToken,
      this.apiUrl,
      (liveDoc) => {
        updated = false;
        const { doc: nd, updated: upd } = updateTableCell(
          liveDoc,
          tableRef,
          row,
          col,
          text,
        );
        updated = upd;
        if (!updated) return null; // table not found -> skip the write entirely
        return nd;
      },
    );
    // #654 — arm read-your-own-writes (no-op when nothing changed).
    this.rememberWrite(pageUuid, mutation.verify);

    if (!updated) {
      throw new Error(
        `tableUpdateCell: no table found for "${tableRef}" on page ${pageId} (use "#<index>" from getOutline, or a block id inside the table)`,
      );
    }
    return {
      success: true,
      table: tableRef,
      row,
      col,
      verify: mutation.verify,
    };
  }

  /**
   * Create a new page with title and content.
   * Uses the /pages/import workaround (the only endpoint accepting content),
   * then moves the page and restores the exact title: the import endpoint
   * derives the title from the FILENAME and replaces spaces with
   * underscores, so we explicitly re-set it via /pages/update afterwards.
   */
  }
  return TablesMixin;
}
