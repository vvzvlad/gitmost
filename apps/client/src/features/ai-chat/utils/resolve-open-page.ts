/**
 * Resolve the AUTHORITATIVE "open page" context to send with the chat stream (and
 * to bind on the server) from the page-metadata query result and the current route
 * page id (#665 live-bug fix).
 *
 * `usePageMetaQuery` is declared with `placeholderData: keepPreviousData`, so when
 * it is disabled (off a page — e.g. on /home) its `data` does NOT become null: it
 * indefinitely holds the LAST viewed page's metadata. Trusting that placeholder
 * would make the server bind an unrelated page to this chat and tell the model
 * "you are on page X" while the user is on /home. So the open page must be the page
 * the ROUTE says we are on, or nothing at all.
 *
 * The comparison is on BOTH slugId and id on purpose: `extractPageSlugId` returns a
 * raw uuid unchanged, and a `/s/<space>/p/<uuid>` URL renders without being
 * canonicalized to a slug, so a slugId-only check would wrongly null out a REAL
 * open page (whose route id is the uuid) — the same "both writers must mean the
 * same page" invariant, broken the other way.
 */
export function resolveOpenPage(
  openPageData: { id: string; slugId: string; title: string } | undefined | null,
  routePageId: string | undefined,
): { id: string; title: string } | null {
  if (!openPageData || !routePageId) return null;
  if (openPageData.slugId === routePageId || openPageData.id === routePageId) {
    return { id: openPageData.id, title: openPageData.title };
  }
  return null;
}
