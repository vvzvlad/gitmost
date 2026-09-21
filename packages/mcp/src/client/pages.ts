// Auto-split from client.ts (issue #450). Mixin over the shared client context.
// Bodies are VERBATIM from the original DocmostClient; only the enclosing class
// changed to a mixin factory. See client/context.ts for the shared base.
import type { GConstructor, DocmostClientContext } from "./context.js";
import FormData from "form-data";
import axios, { AxiosInstance } from "axios";
import { convertProseMirrorToMarkdown } from "../lib/markdown-converter.js";
import {
  updatePageContentRealtime,
  markdownToProseMirror,
  markdownToProseMirrorCanonical,
  mutatePageContent,
  savePageVersionRealtime,
  assertYjsEncodable,
  MutationResult,
} from "../lib/collaboration.js";
import { footnoteWarningsField } from "../lib/footnote-analyze.js";
import {
  serializeDocmostMarkdown,
  parseDocmostMarkdown,
} from "../lib/markdown-document.js";
import { diffDocs, summarizeChange } from "../lib/diff.js";
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
import { regraftResolvedComments } from "../lib/comment-anchor.js";
import vm from "node:vm";

// Public method surface of PagesMixin (issue #450) — a NAMED type so the factory
// return type is expressible in the emitted .d.ts (the anonymous mixin class
// carries the base's protected shared state, which would otherwise trip TS4094).
// Derived from the class below; `implements IPagesMixin` fails to compile on drift.
export interface IPagesMixin {
  createPage(title: string, content: string, spaceId: string, parentPageId?: string): any;
  updatePage(pageId: string, content: string, title?: string, baseHash?: string): any;
  renamePage(pageId: string, title: string): any;
  movePage(pageId: string, parentPageId: string | null, position?: string): any;
  deletePage(pageId: string): any;
  sharePage(pageId: string, searchIndexing?: boolean): any;
  listShares(): any;
  unsharePage(pageId: string): any;
  exportPageMarkdown(pageId: string): Promise<string>;
  importPageMarkdown(pageId: string, fullMarkdown: string): Promise<any>;
  copyPageContent(sourcePageId: string, targetPageId: string): any;
  listPageHistory(pageId: string, cursor?: string): any;
  getPageHistory(historyId: string): any;
  restorePageVersion(historyId: string): any;
  savePageVersion(pageId: string): any;
  diffPageVersions(pageId: string, from?: string, to?: string): any;
}

export function PagesMixin<TBase extends GConstructor<DocmostClientContext>>(Base: TBase): GConstructor<DocmostClientContext & IPagesMixin> & TBase {
  abstract class PagesMixin extends Base implements IPagesMixin {
  /**
   * Create a new page with title and content.
   * Uses the /pages/import workaround (the only endpoint accepting content),
   * then moves the page and restores the exact title: the import endpoint
   * derives the title from the FILENAME and replaces spaces with
   * underscores, so we explicitly re-set it via /pages/update afterwards.
   */
  async createPage(
    title: string,
    content: string,
    spaceId: string,
    parentPageId?: string,
  ) {
    await this.ensureAuthenticated();

    if (parentPageId) {
      try {
        await this.getPage(parentPageId);
      } catch (e) {
        throw new Error(`Parent page with ID ${parentPageId} not found.`);
      }
    }

    // 1. Create content via Import (using multipart/form-data).
    // Build a FRESH FormData per send attempt: a FormData body is a single-use
    // stream consumed on the first send, so it cannot be replayed by
    // this.client's response interceptor (replay fails with 'socket hang up').
    // Multipart re-auth is therefore done here with bare axios and an explicit
    // one-shot 401/403 retry that rebuilds the body.
    const fileContent = Buffer.from(content, "utf-8");
    const buildForm = () => {
      const form = new FormData();
      form.append("spaceId", spaceId);
      // #502: this is an AGENT-authored body (plain prose / config), so tell the
      // server import path to run the markdown importer with the two layered
      // extensions OFF — a `$…$` span stays literal text (real math via
      // `update_page_json`) and a schemeless `www.host`/email is not autolinked
      // (an explicit `https://…` still links). A human file upload never sends
      // this field, so human imports keep math + autolink ON.
      form.append("disableMarkdownExtensions", "true");
      form.append("file", fileContent, {
        filename: `${title || "import"}.md`,
        contentType: "text/markdown",
      });
      return form;
    };

    const importUrl = `${this.apiUrl}/pages/import`;
    let response;
    try {
      // Call buildForm() ONCE per attempt and reuse the instance for both
      // getHeaders() and the body so the Content-Type boundary matches the body.
      const form = buildForm();
      // Read the Authorization header from this.client's defaults (set by
      // login(), only ever deleted — never set to null) instead of building
      // `Bearer ${this.token}`: a concurrent JSON 401 can null this.token
      // mid-flight, which would otherwise produce a literal "Bearer null".
      // ensureAuthenticated() above guarantees login() ran, so the default
      // header exists here.
      response = await axios.post(importUrl, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: this.client.defaults.headers.common["Authorization"],
        },
        timeout: 60000,
      });
    } catch (error) {
      // On an expired-token auth error, re-login and retry exactly once with a
      // freshly-rebuilt FormData (the previous one was already consumed).
      if (
        axios.isAxiosError(error) &&
        (error.response?.status === 401 || error.response?.status === 403)
      ) {
        await this.login();
        const form2 = buildForm();
        response = await axios.post(importUrl, form2, {
          headers: {
            ...form2.getHeaders(),
            Authorization: this.client.defaults.headers.common["Authorization"],
          },
          timeout: 60000,
        });
      } else {
        throw error;
      }
    }
    const newPageId = (response.data?.data ?? response.data).id;

    // 2. Move to parent if needed
    if (parentPageId) {
      await this.movePage(newPageId, parentPageId);
    }

    // 3. Restore the exact title (import mangles spaces into underscores)
    if (title) {
      await this.client.post("/pages/update", { pageId: newPageId, title });
    }

    const page = await this.getPage(newPageId);
    // Surface non-fatal footnote problems (dangling refs, empty/duplicate
    // definitions, markers in tables) so the agent can fix its markup (#166).
    return { ...page, ...footnoteWarningsField(content) };
  }

  /**
   * Update a page's content from markdown and optionally its title.
   * NOTE: full re-import — block ids regenerate. For surgical changes
   * use editPageText / updatePageJson instead.
   */
  async updatePage(
    pageId: string,
    content: string,
    title?: string,
    baseHash?: string,
  ) {
    await this.ensureAuthenticated();

    // #647 §H — baseHash is MANDATORY (updatePageMarkdown always writes the
    // body). It is the opaque hash the agent got from its read (getPage /
    // getPageJson). Refuse when missing rather than silently accept-and-ignore.
    if (!baseHash) {
      throw new Error(
        "updatePageMarkdown: baseHash is required. Read the page first with " +
          "getPage (or getPageJson) to obtain baseHash, pass it here, and on a " +
          "conflict re-read to get a fresh baseHash and retry.",
      );
    }

    // Open the collab doc by the canonical UUID, never the slugId (#260). The
    // REST /pages/update title write below keeps the agent-supplied id (the
    // server resolves a slugId there).
    const pageUuid = await this.resolvePageId(pageId);

    // Import the markdown to a ProseMirror doc. #502: the agent-authored body is
    // plain prose/config, so the two layered markdown extensions are OFF (a
    // `$…$` span stays literal, a schemeless `www.host`/email is not autolinked).
    const importedJson = await markdownToProseMirrorCanonical(content, {
      parseMath: false,
      fuzzyLinkify: false,
    });

    // #493/#647 §H — an agent read HIDES resolved-comment anchors (#337), so the
    // markdown it sends no longer carries them; a naive full rewrite would erase
    // every resolved comment mark. Re-graft the resolved marks from the LIVE doc
    // onto the freshly-imported body. Migrated off the collab-session transform:
    // we fetch the coherent live content via /pages/info?includeContentHash (the
    // live-when-loaded content, coherent with the server hash). Best-effort — a
    // resolved span whose text the agent changed simply does not re-anchor and is
    // surfaced (#555). We do NOT use this fetch's hash for the CAS: the CAS must
    // check the AGENT's baseHash (did the page change since the AGENT read it);
    // if it moved, the guarded replace 409s and the agent re-reads.
    // Fail-closed (#647 review): the regraft below needs the LIVE doc to recover
    // the resolved-comment anchors that the agent's read HID (#337). If this fetch
    // fails — or returns no usable content — we cannot know whether the page
    // carries resolved comments, so we must NOT fall through to the guarded write:
    // when baseHash still matches, that write would land a body missing those
    // anchors and silently drop them — the exact data-loss this epic prevents.
    // Throw a retryable error instead; the caller should re-read (fresh baseHash)
    // and retry. No write is attempted here, so the page is left untouched.
    let liveContent: any;
    try {
      const live = await this.getPageRaw(pageUuid, undefined, {
        includeContentHash: true,
      });
      liveContent = live?.content;
    } catch (e: any) {
      throw new Error(
        `updatePageMarkdown: failed to fetch live content required to preserve ` +
          `resolved comment anchors (${e?.message ?? e}). No write was attempted; ` +
          `re-read the page to get a fresh baseHash and retry.`,
      );
    }
    if (!liveContent) {
      throw new Error(
        `updatePageMarkdown: live-content fetch returned no usable content, so ` +
          `resolved comment anchors cannot be preserved. No write was attempted; ` +
          `re-read the page to get a fresh baseHash and retry.`,
      );
    }
    const finalDoc = regraftResolvedComments(liveContent, importedJson, (w) =>
      console.error(
        `[regraft] page ${pageId}: dropped resolved comment ${w.commentId} ` +
          `(${w.code}) — anchor text ${JSON.stringify(
            w.text.length > 80 ? `${w.text.slice(0, 80)}…` : w.text,
          )} could not be re-grafted onto the rewritten body.`,
      ),
    );

    // Write the BODY first, then the title (#159 split-brain). The guarded
    // replace throws ConflictError on a baseHash mismatch (409); the title is
    // left UNTOUCHED so the page never ends up with a new title over its old body.
    const result = await this.guardedReplacePage(
      pageUuid,
      finalDoc,
      "json",
      baseHash,
    );

    // #654 RYOW: a successful guarded replace always changed the body (it applied or 409'd), so arm the read-your-own-write hint for this client's next structural read.
    this.rememberWrite(pageUuid, { changed: true });

    // Body persisted successfully — now it is safe to set the title.
    if (title) {
      await this.client.post("/pages/update", { pageId, title });
    }

    return {
      success: true,
      modified: true,
      message: "Page updated successfully.",
      pageId: pageId,
      newHash: result.newHash,
      // Non-fatal footnote diagnostics (#166); omitted when there are none.
      ...footnoteWarningsField(content),
    };
  }

  /**
   * Validate a URL string against a scheme allowlist for a given context.
   *
   * The markdown link path enforces safe schemes via TipTap, but the raw
   * JSON path (updatePageJson) bypasses that — so this is the sanitization
   * choke point for ProseMirror JSON written directly by the caller.
   *
   * - "link":  reject javascript:, vbscript:, data: (any scheme that can
   *            execute or smuggle script when the href is clicked).
   * - "src":   allow only http(s):, mailto:, /api/files paths, or a
   *            scheme-less relative/absolute path; reject
   *            javascript:/vbscript:/data:/file:.
   */

  /**
   * Rename a page (change its title only) without touching or resending its
   * content. The slug is derived from the page record, not the body, so it is
   * left intact too.
   */
  async renamePage(pageId: string, title: string) {
    await this.ensureAuthenticated();
    await this.client.post("/pages/update", { pageId, title });
    return { success: true, pageId, title };
  }

  /**
   * Copy the WHOLE content of one page onto another, entirely server-side: the
   * source's ProseMirror document is read and written verbatim onto the target
   * via the live collab path, so the document never passes through the model.
   *
   * Only the target's BODY is replaced — its title and slug live on the page
   * record (not in the content), so they are untouched. The source page is not
   * modified at all.
   */

  async movePage(
    pageId: string,
    parentPageId: string | null,
    position?: string,
  ) {
    await this.ensureAuthenticated();
    // Docmost requires position >= 5 chars.
    const validPosition = position || "a00000";

    return this.client
      .post("/pages/move", {
        pageId,
        parentPageId,
        position: validPosition,
      })
      .then((res) => res.data);
  }


  async deletePage(pageId: string) {
    await this.ensureAuthenticated();
    return this.client
      .post("/pages/delete", { pageId })
      .then((res) => res.data);
  }

  // --- Comment methods (ported from upstream PR #3 by Max Nikitin) ---

  /**
   * Normalize a comment's `content` into a ProseMirror doc object before
   * markdown conversion. createComment/updateComment send content as a
   * JSON.stringify(...) STRING, and the server stores it as-is, so on read it
   * comes back as a string. convertProseMirrorToMarkdown returns "" for a
   * string, so parse it first (guarded — fall back to the raw value on any
   * parse failure so a non-JSON legacy value is still handled gracefully).
   */

  /** Share a page publicly (idempotent) and return the public URL. */
  async sharePage(pageId: string, searchIndexing: boolean = true) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/shares/create", {
      pageId,
      includeSubPages: false,
      searchIndexing,
    });
    const share = response.data?.data ?? response.data;
    const slugId = share.page?.slugId || (await this.getPageRaw(pageId)).slugId;
    return {
      shareId: share.id,
      key: share.key,
      pageId: share.pageId,
      publicUrl: this.shareUrl(share.key, slugId),
      searchIndexing: share.searchIndexing,
    };
  }

  /** List all public shares in the workspace with their URLs. */

  /** Build the public share URL for a page. */
  protected shareUrl(shareKey: string, slugId: string): string {
    return `${this.appUrl}/share/${shareKey}/p/${slugId}`;
  }

  /** Share a page publicly (idempotent) and return the public URL. */

  /** List all public shares in the workspace with their URLs. */
  async listShares() {
    const shares = await this.paginateAll("/shares", {});
    return shares.map((s: any) => ({
      shareId: s.id,
      key: s.key,
      pageId: s.pageId,
      pageTitle: s.page?.title,
      publicUrl: s.page?.slugId ? this.shareUrl(s.key, s.page.slugId) : null,
      searchIndexing: s.searchIndexing,
      createdAt: s.createdAt,
    }));
  }

  /** Remove the public share of a page. */
  async unsharePage(pageId: string) {
    await this.ensureAuthenticated();
    const shares = await this.listShares();
    const share = shares.find((s: any) => s.pageId === pageId);
    if (!share) {
      throw new Error(`Page ${pageId} is not shared.`);
    }
    await this.client.post("/shares/delete", { shareId: share.shareId });
    return { success: true, removedShareId: share.shareId, pageId };
  }


  /**
   * Export a page to a single self-contained Docmost-flavoured markdown file:
   * meta block + body (with inline comment anchors + diagrams) + comment
   * threads. Lossless round-trip target; see importPageMarkdown for the inverse.
   */
  async exportPageMarkdown(pageId: string): Promise<string> {
    await this.ensureAuthenticated();
    const page = await this.getPageRaw(pageId);
    const body = page.content ? convertProseMirrorToMarkdown(page.content) : "";
    let comments: any[] = [];
    try {
      // Lossless export: include RESOLVED threads so the export -> import
      // round-trip preserves every comment. This is exactly why the active-only
      // filter is an opt-in (default false) on listComments.
      comments = (await this.listComments(pageId, true)).items;
    } catch (e) {
      // A comments fetch failure must not lose the body; export with [] and let
      // the caller see the (empty) comments block. Log under DEBUG only.
      if (process.env.DEBUG) console.error("export: listComments failed", e);
    }
    const meta = {
      version: 1,
      pageId: page.id,
      slugId: page.slugId,
      title: page.title,
      spaceId: page.spaceId,
      parentPageId: page.parentPageId ?? null,
    };
    return serializeDocmostMarkdown(meta, body, comments);
  }

  /**
   * Import a self-contained Docmost markdown file back into a page. Parses out
   * the meta + comments metadata blocks, converts the body to ProseMirror
   * (restoring comment marks + diagrams from their inline HTML), and replaces
   * the page content. Comment THREAD records are NOT written to the server in
   * this version — they are preserved in the file and the inline marks are
   * re-applied so the highlights survive; managing comment records stays with
   * the comment tools/UI.
   */
  async importPageMarkdown(pageId: string, fullMarkdown: string): Promise<any> {
    await this.ensureAuthenticated();
    const { meta, body, comments } = parseDocmostMarkdown(fullMarkdown);
    // PAGE import: canonicalize footnotes (see markdownToProseMirrorCanonical).
    const doc = await markdownToProseMirrorCanonical(body);
    const collabToken = await this.getCollabTokenWithReauth();
    // Open the collab doc by the canonical UUID, never the slugId (#260).
    const pageUuid = await this.resolvePageId(pageId);
    // #654 RYOW: route through the replacePage seam (not the free replacePageContent)
    // — the seam arms the read-your-own-write window itself on a real change, exactly
    // like copyPageContent/updatePageJson, so no explicit rememberWrite is needed here.
    const mutation = await this.replacePage(
      pageUuid,
      doc,
      collabToken,
      this.apiUrl,
    );
    // Collect distinct comment ids that actually became comment marks in the doc.
    const collectCommentIds = (node: any, acc: Set<string>): Set<string> => {
      if (!node || typeof node !== "object") return acc;
      if (Array.isArray(node.marks)) {
        for (const mk of node.marks) {
          if (mk && mk.type === "comment" && mk.attrs?.commentId) {
            acc.add(mk.attrs.commentId);
          }
        }
      }
      if (Array.isArray(node.content)) {
        for (const child of node.content) collectCommentIds(child, acc);
      }
      return acc;
    };
    // Count reflects the comment marks present in the written document, so an id
    // that only appears as inert text (e.g. inside a fenced code block) is not
    // counted because it never becomes a comment mark.
    const anchoredIds = collectCommentIds(doc, new Set<string>());
    const result: any = {
      success: true,
      pageId,
      anchoredCommentCount: anchoredIds.size,
      commentsInFile: Array.isArray(comments) ? comments.length : 0,
      verify: mutation.verify,
    };
    // Warn (non-fatal) if the file was exported from a DIFFERENT page.
    if (meta?.pageId && meta.pageId !== pageId) {
      result.warning = `File was exported from page ${meta.pageId} but is being imported into ${pageId}.`;
    }
    // Non-fatal footnote diagnostics (#166), analyzed on the BODY (the part after
    // the docmost:meta / docmost:comments blocks) — so a `[^x]`-like token inside
    // those JSON blocks never produces a false warning, while real markers in the
    // body do. `body` comes from parseDocmostMarkdown(fullMarkdown) above.
    Object.assign(result, footnoteWarningsField(body));
    return result;
  }

  /**
   * Rename a page (change its title only) without touching or resending its
   * content. The slug is derived from the page record, not the body, so it is
   * left intact too.
   */

  /**
   * Copy the WHOLE content of one page onto another, entirely server-side: the
   * source's ProseMirror document is read and written verbatim onto the target
   * via the live collab path, so the document never passes through the model.
   *
   * Only the target's BODY is replaced — its title and slug live on the page
   * record (not in the content), so they are untouched. The source page is not
   * modified at all.
   */
  async copyPageContent(sourcePageId: string, targetPageId: string) {
    await this.ensureAuthenticated();

    // A self-copy would be a no-op overwrite; reject it explicitly so a caller
    // mistake surfaces as a clear error rather than a silent round-trip.
    if (sourcePageId === targetPageId) {
      throw new Error(
        "copyPageContent: sourcePageId and targetPageId are the same page (no-op copy)",
      );
    }

    const source = await this.getPageRaw(sourcePageId);
    const content = source?.content;
    if (
      !content ||
      typeof content !== "object" ||
      content.type !== "doc" ||
      !Array.isArray(content.content)
    ) {
      throw new Error(
        `copyPageContent: source page ${sourcePageId} has no usable ProseMirror content to copy`,
      );
    }

    // Defense-in-depth: run the same URL-scheme sanitizer the JSON write path
    // uses, so copying never lands a javascript:/data: href/src on the target
    // (parity with updatePageJson; harmless for already-stored source content).
    this.validateDocUrls(content);

    // Defense-in-depth (#228): this is a FULL-document write, so canonicalize
    // footnotes before copying — a no-op on already-canonical source content, but
    // it guarantees a copy can never propagate a non-canonical footnote topology
    // to the target (parity with the other full-doc write paths).
    // #419: normalize + merge glyph-forked definitions before canonicalizing.
    const canonical = canonicalizeFootnotes(normalizeAndMergeFootnotes(content));

    const collabToken = await this.getCollabTokenWithReauth();
    // Open the TARGET collab doc by its canonical UUID, never the slugId (#260).
    const targetUuid = await this.resolvePageId(targetPageId);
    const mutation = await this.replacePage(
      targetUuid,
      canonical,
      collabToken,
      this.apiUrl,
    );

    return {
      success: true,
      sourcePageId,
      targetPageId,
      copiedNodes: canonical.content.length,
      verify: mutation.verify,
    };
  }

  /**
   * Surgical text edits: find/replace inside text nodes of the live
   * document. Preserves all block ids, marks, callouts and tables.
   */

  // --- Page history / diff / transform ---

  /**
   * List the saved versions (history snapshots) of a page, newest first.
   * Docmost auto-snapshots on every save. Returns one cursor-paginated page of
   * results: `{ items, nextCursor }`. The history record's id field is `id`.
   */
  async listPageHistory(pageId: string, cursor?: string) {
    await this.ensureAuthenticated();
    const payload: Record<string, any> = { pageId };
    if (cursor) payload.cursor = cursor;
    const response = await this.client.post("/pages/history", payload);
    const data = response.data?.data ?? response.data;
    return {
      items: data?.items ?? [],
      nextCursor: data?.meta?.nextCursor ?? null,
    };
  }

  /**
   * Fetch a single page-history version including its lossless ProseMirror
   * `content`. The version also carries pageId/title/createdAt.
   */
  async getPageHistory(historyId: string) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/pages/history/info", {
      historyId,
    });
    return response.data?.data ?? response.data;
  }

  /**
   * "Restore" a version: Docmost has NO restore endpoint, so we take the
   * version's `content` and write it as the page's current content via the live
   * collab path (which itself creates a new history snapshot). Returns the
   * affected pageId and the source historyId.
   */
  async restorePageVersion(historyId: string) {
    await this.ensureAuthenticated();
    const version = await this.getPageHistory(historyId);
    if (
      !version ||
      !version.pageId ||
      !version.content ||
      typeof version.content !== "object"
    ) {
      throw new Error(
        `restorePageVersion: history ${historyId} has no usable content`,
      );
    }
    // Defense-in-depth: sanitize URLs in the restored content (parity with the
    // JSON write path) before writing it back.
    this.validateDocUrls(version.content);
    const collabToken = await this.getCollabTokenWithReauth();
    // version.pageId is the page entity id (already a UUID); resolvePageId
    // short-circuits a UUID with no round-trip, so this is defensive only (#260).
    const pageUuid = await this.resolvePageId(version.pageId);
    const mutation = await mutatePageContent(
      pageUuid,
      collabToken,
      this.apiUrl,
      () => version.content,
    );
    // #654 — arm read-your-own-writes (no-op when nothing changed).
    this.rememberWrite(pageUuid, mutation.verify);
    return {
      pageId: version.pageId,
      restoredFrom: historyId,
      verify: mutation.verify,
    };
  }

  /**
   * Save an intentional NAMED version of a page's CURRENT live content (#370).
   * The write goes over the same agent-authenticated collab session content edits
   * use, so the server derives kind='agent' from the signed actor. Resolves a
   * SaveVersionResult: `{ saved:true, historyId, kind, alreadySaved }` on success,
   * or `{ saved:false, skipped:true, reason }` when the server had nothing to pin
   * (e.g. an empty page). A stale/missing pageId throws (not a benign skip).
   */
  async savePageVersion(pageId: string) {
    const collabToken = await this.getCollabTokenWithReauth();
    const pageUuid = await this.resolvePageId(pageId);
    // Self-heal a rejected WS handshake once (#486): re-mint the collab token and
    // retry, symmetric to the content-write path.
    return this.writeWithCollabAuthRetry(collabToken, (token) =>
      savePageVersionRealtime(pageUuid, token, this.apiUrl),
    );
  }

  /**
   * Diff two versions of a page and return a Docmost-equivalent change set.
   * `from`/`to` each resolve to a ProseMirror doc:
   *   - null / undefined / "current" -> the page's CURRENT content;
   *   - any other string             -> that historyId's content.
   * Returns the diff plus the resolved version metadata for each side.
   */
  async diffPageVersions(pageId: string, from?: string, to?: string) {
    await this.ensureAuthenticated();

    const isCurrent = (v?: string) => v == null || v === "" || v === "current";

    const resolveSide = async (
      v?: string,
    ): Promise<{ doc: any; meta: any }> => {
      if (isCurrent(v)) {
        const raw = await this.getPageRaw(pageId);
        return {
          doc: raw.content || { type: "doc", content: [] },
          meta: {
            kind: "current",
            pageId,
            title: raw.title,
            updatedAt: raw.updatedAt,
          },
        };
      }
      const version = await this.getPageHistory(v as string);
      return {
        doc: version.content || { type: "doc", content: [] },
        meta: {
          kind: "history",
          historyId: version.id,
          pageId: version.pageId,
          title: version.title,
          createdAt: version.createdAt,
        },
      };
    };

    const fromSide = await resolveSide(from);
    const toSide = await resolveSide(to);
    const diff = diffDocs(fromSide.doc, toSide.doc);
    return { from: fromSide.meta, to: toSide.meta, diff };
  }

  /**
   * Edit a page by running an arbitrary user-supplied JS transform against the
   * live document, with a diff preview + page-history safety net.
   *
   * The transform string is evaluated as `(doc, ctx) => doc` inside a node:vm
   * sandbox: it gets ONLY `{ doc, ctx, structuredClone, console }` as globals,
   * a 5s timeout, and NO access to require/process/fs/network. It must return a
   * `{ type: "doc" }` node, which is validated structurally before any write.
   *
   * `ctx` exposes:
   *   - comments: the page's comments (fetched before the live read);
   *   - log: an array the transform can push diagnostics to (via console.log);
   *   - consume(id): mark a comment id as consumed (for deleteComments);
   *   - helpers: the transforms.ts primitives + commentsToFootnotes.
   *
   * Footnote convention used by the helpers: footnote markers are plain "[N]"
   * text in the body, and the notes are an orderedList under a heading whose
   * text is "Примечания переводчика".
   *
   * dryRun (default true): read the page's current content, run the transform,
   * and return `{ pushed:false, diff, log }` WITHOUT opening the collab socket.
   * Otherwise the transform runs atomically inside mutatePageContent, optionally
   * deletes consumed comments, and returns the new historyId + diff + log.
   */
  }
  return PagesMixin;
}
