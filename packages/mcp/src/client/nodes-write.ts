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
import {
  importMarkdownFragment,
  canBeDocChild,
  findUnrepresentableTableAttrs,
} from "../lib/markdown-fragment.js";
import {
  applyTextEdits,
  TextEdit,
  TextEditResult,
  TextEditFailure,
} from "../lib/json-edit.js";
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
import { normalizeAndMergeFootnotes } from "../lib/footnote-normalize-merge.js";

// Public method surface of NodesWriteMixin (issue #450) — a NAMED type so the factory
// return type is expressible in the emitted .d.ts (the anonymous mixin class
// carries the base's protected shared state, which would otherwise trip TS4094).
// Derived from the class below; `implements INodesWriteMixin` fails to compile on drift.
export interface INodesWriteMixin {
  updatePageJson(pageId: string, doc?: any, title?: string, baseHash?: string): any;
  editPageText(pageId: string, edits: TextEdit[]): any;
  patchNode(pageId: string, nodeId: string, input: { markdown?: string; node?: any }): any;
  insertNode(pageId: string, input: { markdown?: string; node?: any }, opts: { position: "before" | "after" | "append"; anchorNodeId?: string; anchorText?: string; }): any;
  deleteNode(pageId: string, nodeId: string): any;
}

/**
 * Reject a ProseMirror doc that carries a sandbox `/api/sb/` src anywhere
 * (#629). Those srcs only ever originate from stashPage's one-way publication
 * view (RAM-only, TTL-bound blobs); persisting one as page content would leave a
 * link that 404s once the blob expires. Throws with the offending src.
 */
function assertNoSandboxSrc(doc: unknown): void {
  const visit = (node: any): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node !== "object") return;
    const src = node.attrs?.src;
    if (typeof src === "string" && src.includes("/api/sb/")) {
      throw new Error(
        `updatePageJson: refusing a src that points at the blob sandbox ` +
          `("${src}"). That is a stashPage publication-view URL (RAM-only, ` +
          `expires) — do NOT write a stashed doc back as page content.`,
      );
    }
    if (Array.isArray(node.content)) for (const child of node.content) visit(child);
  };
  visit(doc);
}

export function NodesWriteMixin<TBase extends GConstructor<DocmostClientContext>>(Base: TBase): GConstructor<DocmostClientContext & INodesWriteMixin> & TBase {
  abstract class NodesWriteMixin extends Base implements INodesWriteMixin {
  /**
   * Replace page content with a raw ProseMirror JSON document (lossless) and/or
   * update its title. Both `doc` and `title` are optional, but at least one must
   * be supplied:
   *  - `doc` provided   -> validate + full-overwrite the body (and update the
   *                        title too when `title` is also given).
   *  - `doc` omitted, `title` given -> title-only update; the body is NOT
   *                        touched/resent (no collab write happens).
   *  - neither given    -> throws (nothing to update).
   */
  async updatePageJson(
    pageId: string,
    doc?: any,
    title?: string,
    baseHash?: string,
  ) {
    await this.ensureAuthenticated();

    // Title-only / no-op handling: when no document is supplied, do NOT write
    // the body. Update the title if one was given; otherwise there is nothing
    // to do, so fail loudly rather than silently no-op.
    if (doc == null) {
      if (!title) {
        throw new Error(
          "updatePageJson: nothing to update (provide content and/or title)",
        );
      }
      await this.client.post("/pages/update", { pageId, title });
      return {
        success: true,
        modified: true,
        message: "Page title updated (content left unchanged).",
        pageId,
      };
    }

    // Validate the document shape before a full overwrite: a malformed doc
    // would otherwise silently corrupt the page (full-overwrite is the
    // documented behaviour; no optimistic-concurrency is applied here).
    if (
      typeof doc !== "object" ||
      doc.type !== "doc" ||
      !Array.isArray(doc.content)
    ) {
      throw new Error(
        'content must be a ProseMirror document ({"type":"doc","content":[...]}) ' +
          "where content is an array of nodes each having a string `type`",
      );
    }

    // Recurse the WHOLE document so a malformed nested node (e.g. a node with a
    // non-string type, a non-array content/marks, or a text node missing its
    // string text) is rejected up front rather than silently corrupting the
    // page on overwrite.
    this.validateDocStructure(doc);

    // #409: beyond the string-`type` check above, reject a nested node whose
    // `type` is a string but NOT a known Docmost schema node (a typo/unknown
    // block) — the same `Unknown node type` the encoder throws — with a rich,
    // path-anchored message, still BEFORE any collab connection.
    this.assertValidNodeShape("updatePageJson", doc);

    // Sanitize URLs before writing. This closes the JSON-path bypass: unlike
    // the markdown link path (which TipTap sanitizes), raw JSON could otherwise
    // inject javascript:/data: link hrefs or media srcs straight into the doc.
    this.validateDocUrls(doc);

    // Reject a doc carrying a sandbox `/api/sb/` src (#629): stashPage returns a
    // PUBLICATION VIEW (its drawio diagrams become `image` nodes pointing at
    // ephemeral RAM-only sandbox blobs, and every internal image is rewritten to
    // one). Writing that back as page content would persist dead links that 404
    // as soon as the blob's TTL lapses — the stash is one-way, never round-trip.
    assertNoSandboxSrc(doc);

    // Canonicalize footnotes (idempotent): an agent-authored JSON doc cannot
    // leave footnotes out of order, orphaned, or in multiple lists — the bottom
    // list + numbering are always derived from reference order. No-op when the
    // footnotes are already canonical.
    // #419: normalize + merge glyph-forked definitions before canonicalizing.
    doc = normalizeAndMergeFootnotes(doc);
    doc = canonicalizeFootnotes(doc);

    // #647 §G — a full body overwrite goes through the SERVER-side write-CAS
    // (guarded replace), not the old client-collab seam. `baseHash` is MANDATORY
    // when writing content: it is the opaque hash the agent got from the read
    // (getPageJson/getPage). Refuse rather than silently accept-and-ignore it —
    // an ignored baseHash would give a false sense of safety while still
    // clobbering a concurrent edit (the exact bug this closes). A title-only
    // update (doc omitted) needs no baseHash and never reaches here.
    if (!baseHash) {
      throw new Error(
        "updatePageJson: baseHash is required when writing content. Read the " +
          "page first with getPageJson (or getPage) to obtain baseHash, pass it " +
          "here, and on a conflict re-read to get a fresh baseHash and retry.",
      );
    }

    // Write the BODY first, then the title (#159 split-brain): a failed body
    // write (e.g. a 409 conflict) must not leave a new title over the old body.
    // The guarded replace throws ConflictError on a baseHash mismatch (409).
    const result = await this.guardedReplacePage(pageId, doc, "json", baseHash);

    // Body persisted successfully — now it is safe to set the title.
    if (title) {
      await this.client.post("/pages/update", { pageId, title });
    }

    return {
      success: true,
      modified: true,
      message: "Page content replaced from ProseMirror JSON.",
      pageId,
      newHash: result.newHash,
    };
  }

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

  /**
   * Surgical text edits: find/replace inside text nodes of the live
   * document. Preserves all block ids, marks, callouts and tables.
   */
  async editPageText(pageId: string, edits: TextEdit[]) {
    await this.ensureAuthenticated();

    const collabToken = await this.getCollabTokenWithReauth();
    // Open the collab doc by the canonical UUID, never the slugId (#260).
    const pageUuid = await this.resolvePageId(pageId);

    // Apply the edits against the LIVE synced document, not the debounced REST
    // snapshot, so concurrent human edits/comments are preserved. applyTextEdits
    // records per-edit match problems in `failed` instead of throwing, and
    // applies whatever it can; we abort the write only when nothing applied.
    let results: TextEditResult[] | undefined;
    let failed: TextEditFailure[] | undefined;
    // Whether we actually wrote new content. Set inside the transform: a
    // degenerate edit (e.g. find === replace, or a batch that nets to no change)
    // can "apply" yet leave the document byte-for-byte identical, in which case
    // we must NOT write (no spurious history version) and must not claim a write
    // happened.
    let wrote = false;
    const mutation = await mutatePageContent(
      pageUuid,
      collabToken,
      this.apiUrl,
      (liveDoc) => {
        wrote = false;
        const r = applyTextEdits(liveDoc, edits);
        results = r.results;
        failed = r.failed;
        // Nothing applied -> abort the write (mutatePageContent treats a null
        // return from the transform as "write nothing").
        if (r.results.length === 0) return null;
        // Edits "applied" but produced an identical document: skip the write so
        // no new history version is created. Stable structural comparison via
        // JSON.stringify (both docs come from the same deep-copied source, so
        // key order is stable).
        if (JSON.stringify(r.doc) === JSON.stringify(liveDoc)) return null;
        wrote = true;
        return r.doc;
      },
    );
    // #654 — arm read-your-own-writes (no-op when nothing changed).
    this.rememberWrite(pageUuid, mutation.verify);

    if ((results?.length ?? 0) === 0 && (failed?.length ?? 0) > 0) {
      // No edit applied: surface an aggregated, actionable error so the caller
      // does not mistake a no-op for a partial success.
      throw new Error(
        "editPageText: no edits were applied (nothing written). " +
          failed!.map((f) => `"${f.find}": ${f.reason}`).join("; "),
      );
    }

    // Edits matched but produced no content change (identical document): report
    // a successful no-op — NOT a failure — and do not falsely claim a write.
    if (!wrote) {
      // A fold-tier no-op means the edit only differed in invisible characters,
      // which fold-matching treats as already-equal: point the caller at the
      // self-correction path (#658).
      const foldNoop = (results ?? []).some(
        (r) => r.matchedVia === "fold" || r.matchedVia === "markdown+fold",
      );
      const message = foldNoop
        ? "No changes written (edits produced identical content). The find matched the same text modulo invisible characters (e.g. soft hyphen / NBSP), so there was nothing to change. To edit invisible characters, copy the exact document text (e.g. from a searchInPage match) into find."
        : "No changes written (edits produced identical content).";
      return {
        success: true,
        pageId,
        applied: results,
        failed,
        message,
        verify: mutation.verify,
      };
    }

    const result: any = {
      success: true,
      pageId,
      applied: results,
      failed,
      message:
        (failed?.length ?? 0)
          ? `Applied ${results?.length ?? 0} edit(s); ${failed!.length} failed (see failed[]). Node ids and formatting preserved.`
          : "Text edits applied (node ids and formatting preserved).",
      verify: mutation.verify,
    };

    // Surface per-edit warnings from applyTextEdits (mirrors the `normalized`
    // channel). Two sources, joined into the single result.warning string:
    //  - literal-marker toggles that applied via the literal-exception (each
    //    result carries its own `.warning`); and
    //  - edits that matched only after stripping markdown (normalized): warn that
    //    editPageText preserved existing marks and did NOT change formatting, so a
    //    caller who intended a formatting change is pointed at patchNode.
    const warnings: string[] = [];
    for (const r of results ?? []) {
      if (r.warning) warnings.push(`"${r.find}": ${r.warning}`);
    }
    if (results?.some((r) => r.normalized === true)) {
      warnings.push(
        "Some edits matched only after stripping markdown from your find string; " +
          "editPageText preserved existing marks (it did not change bold/strike/etc.). " +
          "If you intended a formatting change, use patchNode.",
      );
    }
    if (warnings.length > 0) result.warning = warnings.join(" ");

    return result;
  }

  /**
   * Replace the block whose attrs.id === nodeId. Operates on the LIVE collab
   * document so comments and concurrent edits are preserved.
   *
   * Exactly one of `input.markdown` / `input.node` (#413):
   *  - `markdown` (RECOMMENDED): the block is rewritten from a canonical markdown
   *    fragment. The fragment may import to N blocks (a "1 -> N" splice: rewrite a
   *    whole section in one call). The FIRST resulting block INHERITS the target's
   *    `attrs.id` (so an existing comment anchoring the block by id survives); the
   *    rest get FRESH ids. `^[...]` footnotes in the fragment are first-class:
   *    their definitions merge into the page's TAIL footnote list (content-key
   *    dedup + canonicalize), same machinery insertFootnote uses. REJECTED when
   *    the TARGET block carries a table-cell attribute markdown cannot represent
   *    (colspan/rowspan/colwidth/background) — use the table tools or `node`.
   *  - `node`: a raw ProseMirror node for precise attr/mark work. The replacement
   *    keeps the target id (if `node.attrs.id` is missing it is set to nodeId).
   *
   * #159 ambiguous-id semantics are unchanged: 0 matches -> "no node"; >1 matches
   * -> "ambiguous, refused" (nothing written), on BOTH paths — the markdown path
   * runs a dry `replaceNodeById` count first, so a duplicated id never splices.
   */
  async patchNode(
    pageId: string,
    nodeId: string,
    input: { markdown?: string; node?: any },
  ) {
    await this.ensureAuthenticated();

    // XOR: exactly one of markdown / node. Both optional in the schema; the
    // runtime enforces the recommendation ("markdown for prose, node for fine
    // work") without letting an ambiguous both-or-neither call through.
    const hasMd =
      input != null &&
      typeof input.markdown === "string" &&
      input.markdown.trim() !== "";
    const hasNode = input != null && input.node != null;
    if (hasMd === hasNode) {
      throw new Error(
        "patchNode: provide exactly one of `markdown` (recommended, for prose) " +
          "or `node` (a raw ProseMirror node, for precise attr/mark work)",
      );
    }

    if (hasMd) {
      return this.patchNodeMarkdown(pageId, nodeId, input.markdown as string);
    }
    return this.patchNodeJson(pageId, nodeId, input.node);
  }

  /**
   * patchNode with a raw ProseMirror `node` (the pre-#413 behavior). Replaces
   * EVERY node whose attrs.id === nodeId; the swapped-in node keeps the target
   * id. #159 ambiguity refused. Split out so the markdown path can reuse the
   * shared collab/guard plumbing without a giant branch.
   */
  protected async patchNodeJson(pageId: string, nodeId: string, node: any) {
    if (!node || typeof node !== "object" || typeof node.type !== "string") {
      throw new Error(
        "patchNode: `node` must be an object with a string `type`",
      );
    }
    // Preserve the block id WITHOUT mutating the caller's object: build a local
    // copy whose attrs.id === nodeId (so the swapped-in node keeps the id of the
    // node it replaces).
    const target = {
      ...node,
      attrs: {
        ...(node.attrs && typeof node.attrs === "object" ? node.attrs : {}),
      },
    };
    if (target.attrs.id == null) {
      target.attrs.id = nodeId;
    }

    // #409: fail fast on a malformed node SHAPE (a nested child with an
    // absent/unknown `type`, e.g. a text leaf written as `{"text":"foo"}` with
    // no `"type":"text"`) BEFORE opening a collab session or taking the page
    // lock — the root-only `typeof node.type === "string"` check above never
    // sees nested children, and the encoder's `Unknown node type: undefined`
    // would otherwise only surface after the connection.
    this.assertValidNodeShape("patchNode", target);

    const collabToken = await this.getCollabTokenWithReauth();
    // Open the collab doc by the canonical UUID, never the slugId (#260).
    const pageUuid = await this.resolvePageId(pageId);

    // Track the replacement count in an outer var, reset per-transform, so a
    // collab retry recomputes it cleanly (mirrors replaceImage's pattern).
    let replaced = 0;
    const mutation = await mutatePageContent(
      pageUuid,
      collabToken,
      this.apiUrl,
      (liveDoc) => {
        replaced = 0;
        const { doc: nd, replaced: r } = replaceNodeById(
          liveDoc,
          nodeId,
          target,
        );
        replaced = r;
        // 0 matches -> skip the write. >1 matches -> the id is AMBIGUOUS: Docmost
        // duplicates block ids on copy/paste (and copyPageContent writes them
        // verbatim), so replacing "the node with id X" would silently clobber
        // EVERY duplicate (#159). Refuse: skip the write and throw below so the
        // model re-targets with a more specific anchor instead of corrupting the
        // page. Only an unambiguous single match is written.
        if (replaced !== 1) return null;
        return nd;
      },
    );
    // #654 — arm read-your-own-writes (no-op when nothing changed).
    this.rememberWrite(pageUuid, mutation.verify);

    // 0 -> "no node"; >1 -> "ambiguous, refused" (the transform already skipped
    // the write for any count !== 1). Single shared guard (#159, #185 review).
    assertUnambiguousMatch("patchNode", "replace", replaced, nodeId, pageId);

    return { success: true, replaced, nodeId, verify: mutation.verify };
  }

  /**
   * patchNode with a MARKDOWN fragment (#413). Imports the fragment through the
   * canonical importer, then 1 -> N splices the resulting blocks in place of the
   * target block on the LIVE collab doc:
   *  - the FIRST block inherits the target's id; the rest get FRESH ids (minted
   *    by the importer/id-remap, so neighbour blocks are untouched);
   *  - `^[...]` footnote definitions merge into the page's tail list;
   *  - REJECTED when the target block carries a markdown-unrepresentable table
   *    attr (colspan/rowspan/colwidth/background) — guarding against silent loss;
   *  - #159 ambiguity is enforced by a dry `replaceNodeById` count BEFORE the
   *    splice, so a duplicated id never writes.
   */
  protected async patchNodeMarkdown(
    pageId: string,
    nodeId: string,
    markdown: string,
  ) {
    // Import the fragment up front (network-free, canonical) so a bad fragment
    // fails before any collab connection or page lock.
    const { blocks, definitions } = await importMarkdownFragment(markdown);

    // The first imported block inherits the target id; the rest keep the fresh
    // ids the importer assigned. Build the thread now so it is stable across a
    // collab retry (the transform below is pure over its inputs).
    const threaded = blocks.map((b, i) => {
      if (i !== 0) return b;
      return {
        ...b,
        attrs: {
          ...(b && typeof b.attrs === "object" ? b.attrs : {}),
          id: nodeId,
        },
      };
    });

    // Shape-validate every imported block up front (parity with the JSON path):
    // the importer only emits schema nodes, but the check is cheap insurance and
    // yields the same rich #409 diagnostics if the schema ever drifts.
    for (const b of threaded) {
      this.assertValidNodeShape("patchNode", b);
    }

    const collabToken = await this.getCollabTokenWithReauth();
    // Open the collab doc by the canonical UUID, never the slugId (#260).
    const pageUuid = await this.resolvePageId(pageId);

    let replaced = 0;
    let guardAttrs: string | null = null;
    const mutation = await mutatePageContent(
      pageUuid,
      collabToken,
      this.apiUrl,
      (liveDoc) => {
        replaced = 0;
        guardAttrs = null;

        // #159: count matches with the same recursive walk the JSON path uses;
        // only an UNAMBIGUOUS single match may write. A dry count keeps the
        // ambiguity semantics identical across both paths.
        const { replaced: count } = replaceNodeById(liveDoc, nodeId, {
          type: "paragraph",
        });
        replaced = count;
        if (count !== 1) return null;

        // Guard against SILENT LOSS: if the target block carries a table-cell
        // attribute markdown cannot represent (colspan/rowspan/colwidth/
        // background), refuse the markdown rewrite so those attrs are not
        // dropped. Simple tables (no such attrs) rewrite fine.
        const hit = getNodeByRef(liveDoc, nodeId);
        guardAttrs = hit ? findUnrepresentableTableAttrs(hit.node) : null;
        if (guardAttrs != null) return null;

        // Re-mint any minted block id that collides with an existing page id
        // (skip index 0: its id is intentionally the target nodeId, unique by
        // the #159 dry-count above), so the 1 -> N splice stays page-wide unique.
        reassignCollidingBlockIds(liveDoc, threaded, 0);

        // 1 -> N splice, then merge any fragment footnote definitions into the
        // page's tail list and re-derive canonical footnote numbering.
        const { doc: spliced } = replaceNodeByIdWithMany(
          liveDoc,
          nodeId,
          threaded,
        );
        return mergeFootnoteDefinitions(spliced, definitions);
      },
    );
    // #654 — arm read-your-own-writes (no-op when nothing changed).
    this.rememberWrite(pageUuid, mutation.verify);

    // Surface the guard rejection with an actionable message (nothing written).
    if (guardAttrs != null) {
      throw new Error(
        `patchNode: the target block has table-cell attributes markdown cannot ` +
          `represent (${guardAttrs}) — a markdown rewrite would drop them. Use ` +
          `the table tools (tableUpdateCell/tableInsertRow) or pass a raw ` +
          `ProseMirror \`node\` instead of \`markdown\`.`,
      );
    }

    // 0 -> "no node"; >1 -> "ambiguous, refused" (the transform skipped the write
    // for any count !== 1). Shared #159 guard, identical to the JSON path.
    assertUnambiguousMatch("patchNode", "replace", replaced, nodeId, pageId);

    return {
      success: true,
      replaced,
      nodeId,
      blocks: threaded.length,
      verify: mutation.verify,
    };
  }

  /**
   * Insert content relative to an anchor (or append it at the top level).
   * Operates on the LIVE collab document so comments and concurrent edits are
   * preserved.
   *
   * Exactly one of `input.markdown` / `input.node` (#413):
   *  - `markdown` (RECOMMENDED): a canonical markdown fragment. It may import to
   *    SEVERAL blocks — they are inserted IN ORDER at the anchor. `^[...]`
   *    footnote definitions merge into the page's tail list (same machinery as
   *    insertFootnote). Every inserted block gets a fresh id.
   *  - `node`: a raw ProseMirror node for precise attr/mark work, or to insert
   *    table structure (a bare tableRow/tableCell/tableHeader — NOT expressible in
   *    markdown, so those stay JSON-only).
   *
   * opts.position:
   *  - "append": push the content at the end of the top-level content.
   *  - "before"/"after": insert as a sibling of the anchor, just before/after it.
   *    Exactly one of anchorNodeId / anchorText must be given; anchorNodeId
   *    locates a node anywhere by attrs.id, anchorText matches the first top-level
   *    block whose plain text includes it.
   *
   * Throws if the anchor cannot be found.
   */
  async insertNode(
    pageId: string,
    input: { markdown?: string; node?: any },
    opts: {
      position: "before" | "after" | "append";
      anchorNodeId?: string;
      anchorText?: string;
    },
  ) {
    await this.ensureAuthenticated();

    // XOR: exactly one of markdown / node (both optional in the schema).
    const hasMd =
      input != null &&
      typeof input.markdown === "string" &&
      input.markdown.trim() !== "";
    const hasNode = input != null && input.node != null;
    if (hasMd === hasNode) {
      throw new Error(
        "insertNode: provide exactly one of `markdown` (recommended, for prose) " +
          "or `node` (a raw ProseMirror node, for precise attr/mark work or table structure)",
      );
    }

    if (
      !opts ||
      (opts.position !== "before" &&
        opts.position !== "after" &&
        opts.position !== "append")
    ) {
      throw new Error(
        'insertNode: `position` must be one of "before", "after", "append"',
      );
    }
    if (opts.position === "before" || opts.position === "after") {
      // before/after require EXACTLY ONE anchor (an id or a text fragment).
      const hasId =
        typeof opts.anchorNodeId === "string" && opts.anchorNodeId.length > 0;
      const hasText =
        typeof opts.anchorText === "string" && opts.anchorText.length > 0;
      if (hasId === hasText) {
        throw new Error(
          `insertNode: position "${opts.position}" requires exactly one of anchorNodeId or anchorText`,
        );
      }
    }

    // Resolve the ordered list of blocks to insert plus any footnote definitions
    // to merge. The markdown path imports canonically (so an inserted block is
    // byte-identical to the same content in a full-page import); the node path is
    // a single block with no footnote merge (raw JSON `^[...]` is not touched).
    let blocks: any[];
    let definitions: any[] = [];
    if (hasMd) {
      const frag = await importMarkdownFragment(input.markdown as string);
      blocks = frag.blocks;
      definitions = frag.definitions;
    } else {
      const node = input.node;
      if (!node || typeof node !== "object" || typeof node.type !== "string") {
        throw new Error(
          "insertNode: `node` must be an object with a string `type`",
        );
      }
      blocks = [node];
    }

    // #409: fail fast on a malformed node SHAPE (a nested child with an
    // absent/unknown `type`) BEFORE opening a collab session or taking the page
    // lock — the root-only check above never sees nested children.
    for (const b of blocks) {
      this.assertValidNodeShape("insertNode", b);
    }

    const collabToken = await this.getCollabTokenWithReauth();
    // Open the collab doc by the canonical UUID, never the slugId (#260).
    const pageUuid = await this.resolvePageId(pageId);

    // Track insertion in an outer var, reset per-transform, so a collab retry
    // recomputes it cleanly (mirrors replaceImage's pattern).
    let inserted = false;
    const mutation = await mutatePageContent(
      pageUuid,
      collabToken,
      this.apiUrl,
      (liveDoc) => {
        inserted = false;
        // Re-mint any minted block id that collides with an existing page id
        // (all inserted blocks are fresh, no skip) so the splice stays unique.
        if (hasMd) reassignCollidingBlockIds(liveDoc, blocks);
        // Single-block node path keeps `insertNodeRelative` (it owns the
        // structural table-node splicing); the markdown path uses the array
        // splice so N blocks land in order at one anchor.
        const res = hasMd
          ? insertNodesRelative(liveDoc, blocks, opts)
          : insertNodeRelative(liveDoc, blocks[0], opts);
        inserted = res.inserted;
        if (!inserted) return null; // anchor not found -> skip the write entirely
        // Merge any fragment footnote definitions into the page tail list and
        // re-derive canonical numbering (no-op when there are none).
        return mergeFootnoteDefinitions(res.doc, definitions);
      },
    );
    // #654 — arm read-your-own-writes (no-op when nothing changed).
    this.rememberWrite(pageUuid, mutation.verify);

    if (!inserted) {
      const anchorDesc = opts.anchorNodeId
        ? `anchorNodeId "${opts.anchorNodeId}"`
        : `anchorText "${opts.anchorText}"`;
      // anchorText is matched against the block's literal RENDERED plain text;
      // markdown/emoji are tolerated only as a strip-and-retry fallback, so a
      // miss usually means the text differs from what's on the page.
      const hint = opts.anchorText
        ? " anchorText must be the block's literal rendered plain text (no markdown wrappers or emoji); anchorNodeId from getPageJson is more reliable."
        : "";
      throw new Error(
        `insertNode: anchor not found (${anchorDesc}) on page ${pageId}.${hint}`,
      );
    }

    return {
      success: true,
      inserted: true,
      position: opts.position,
      blocks: blocks.length,
      verify: mutation.verify,
    };
  }

  /**
   * Remove EVERY node whose attrs.id === nodeId (recursively, including nodes
   * nested in callouts/tables) from its parent content array. Operates on the
   * LIVE collab document so comments and concurrent edits are preserved.
   * Throws if no node matches.
   */
  async deleteNode(pageId: string, nodeId: string) {
    await this.ensureAuthenticated();

    const collabToken = await this.getCollabTokenWithReauth();
    // Open the collab doc by the canonical UUID, never the slugId (#260).
    const pageUuid = await this.resolvePageId(pageId);

    // Track the deletion count in an outer var, reset per-transform, so a
    // collab retry recomputes it cleanly (mirrors replaceImage's pattern).
    let deleted = 0;
    const mutation = await mutatePageContent(
      pageUuid,
      collabToken,
      this.apiUrl,
      (liveDoc) => {
        deleted = 0;
        const { doc: nd, deleted: d } = deleteNodeById(liveDoc, nodeId);
        deleted = d;
        // 0 matches -> skip the write. >1 matches -> the id is AMBIGUOUS (block
        // ids are duplicated on copy/paste, #159): deleting "the node with id X"
        // would silently remove EVERY duplicate. Refuse: skip the write and throw
        // below so the model re-targets. Only an unambiguous single match is
        // deleted.
        if (deleted !== 1) return null;
        return nd;
      },
    );
    // #654 — arm read-your-own-writes (no-op when nothing changed).
    this.rememberWrite(pageUuid, mutation.verify);

    // 0 -> "no node"; >1 -> "ambiguous, refused" (the transform already skipped
    // the write for any count !== 1). Single shared guard (#159, #185 review).
    assertUnambiguousMatch("deleteNode", "delete", deleted, nodeId, pageId);

    return { success: true, deleted, nodeId, verify: mutation.verify };
  }

  /** Build the public share URL for a page. */
  }
  return NodesWriteMixin;
}
