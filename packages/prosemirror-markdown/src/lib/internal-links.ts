/**
 * Detect and mark unambiguously-internal wiki-page links during markdown import.
 *
 * WHY THIS EXISTS
 * ---------------
 * The markdown converter (`markdownToProseMirrorSync`) materializes every link
 * with StarterKit's external defaults — `internal: null`, `target: "_blank"`,
 * `rel: "noopener noreferrer nofollow"`. A markdown link that points at an
 * internal wiki page written in its host-less, root-relative form
 * (`[text](/s/<space>/p/<slugId>)`) is therefore stored as EXTERNAL: it opens in
 * a new tab, gets no hover-preview, and is invisible to the backlink graph
 * (`extractInternalLinkSlugIds` only counts links whose mark carries
 * `internal: true`). This module supplies the pure primitive that a post-walk in
 * the converter uses to promote such links to their native internal form.
 *
 * WHERE THE CANON LIVES (a strict subset, on purpose)
 * ---------------------------------------------------
 * The authoritative definition of "what is an internal link path" is the
 * server's `INTERNAL_LINK_REGEX`
 * (`apps/server/src/integrations/export/utils.ts`):
 *   /^(https?:\/\/)?([^\/]+)?(\/s\/([^\/]+)\/)?p\/([a-zA-Z0-9-]+)\/?$/
 * This package is a lower layer than the server app and cannot import it, so the
 * matcher below is a DOCUMENTED, STRICT SUBSET of that regex: it accepts only the
 * space-qualified, root-relative page path `/s/<space>/p/<slug>` (with optional
 * trailing slash). Because it is a subset, every link we mark internal here is
 * guaranteed to also satisfy the server regex, hence guaranteed backlink-able and
 * export-rewritable. A unit test pins the exact accept/reject set as the guard
 * against drift.
 *
 * FAIL-TOWARD-EXTERNAL
 * --------------------
 * We mark a link internal ONLY on an unambiguous anchored match. Any ambiguity
 * (a scheme/host, `#anchor`, `?query`, a space-less `/p/<slug>`, a relative
 * `p/<slug>`, a non-string href) leaves the link external. A false-external is a
 * soft degradation (a new tab); a false-internal would produce broken SPA
 * navigation, so "external" is the conservative default.
 *
 * Precedent for the target internal shape: the file importer already promotes
 * internal anchors (`apps/server/src/integrations/import/utils/import-formatter.ts`
 * `$a.attr('data-internal','true')`) and editor-ext reads it
 * (`packages/editor-ext/src/lib/link.ts`).
 */

/**
 * Matches ONLY the space-qualified, root-relative internal page path
 * `/s/<space>/p/<slug>` (with optional trailing slash). A STRICT SUBSET of the
 * server's `INTERNAL_LINK_REGEX`:
 *   - `<space>` = `[^/]+`   (any non-slash segment, as in the server's group 4)
 *   - `<slug>`  = `[a-zA-Z0-9-]+`  (as in the server's group 5 / `extractPageSlugId`)
 * Anchored on both ends so a scheme/host, a trailing `#anchor`/`?query`, or any
 * extra path segment fails to match.
 */
const INTERNAL_PAGE_PATH = /^\/s\/[^/]+\/p\/[a-zA-Z0-9-]+\/?$/;

/**
 * True iff `href` is the unambiguous, space-qualified, root-relative internal
 * page path. Pure and side-effect-free. Non-string input returns false.
 */
export function isInternalPagePath(href: unknown): boolean {
  return typeof href === "string" && INTERNAL_PAGE_PATH.test(href);
}

/**
 * The native internal-link attribute overrides applied to a link mark whose href
 * is an internal page path. Mirrors the manual JSON-patch form
 * (`{internal:true, target:null, rel:null}`) and the editor-ext/file-importer
 * precedent: internal links carry no `target`/`rel` (same-tab SPA navigation).
 */
const INTERNAL_LINK_ATTRS = { internal: true, target: null, rel: null } as const;

/**
 * In-place post-walk of a finished ProseMirror doc that promotes every
 * unambiguously-internal link mark to its native internal form.
 *
 * A link that spans several text nodes (e.g. `[**bold** word](/s/x/p/abc)`)
 * stores an equivalent link mark on EACH covered text node — and a covered node
 * may carry nested marks (bold/italic) alongside the link. We therefore walk the
 * entire tree and rewrite EVERY `link` mark whose href passes
 * `isInternalPagePath`, so no covered segment is left external.
 *
 * Pure of external effects and IDEMPOTENT: re-running on an already-marked doc
 * leaves it unchanged (an internal-path href always maps to the same attrs).
 * External links are never touched — their `target:_blank`/`rel:noopener…` stay.
 *
 * The doc is mutated in place (the converter owns the freshly-built doc and
 * returns it directly); the same node reference is returned for convenience.
 */
export function markInternalLinks<T>(node: T): T {
  walk(node);
  return node;
}

function walk(node: any): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child);
    return;
  }
  if (Array.isArray(node.marks)) {
    for (const mark of node.marks) {
      if (
        mark &&
        mark.type === "link" &&
        mark.attrs &&
        isInternalPagePath(mark.attrs.href)
      ) {
        mark.attrs = { ...mark.attrs, ...INTERNAL_LINK_ATTRS };
      }
    }
  }
  if (Array.isArray(node.content)) walk(node.content);
}
