export interface CurrentPageInput {
  id?: string;
  title?: string;
}

export interface CurrentPageResult {
  page: { id: string; title: string } | null;
}

// Resolve the "current page" tool result from the client-supplied open-page
// context. Returns { page: null } when no page is open (no id), otherwise the
// page id + title (title defaults to '' when absent). Mirrors the getCurrentPage
// tool's contract so it can be unit-tested without the ESM Docmost client.
export function resolveCurrentPageResult(
  openedPage?: CurrentPageInput | null,
): CurrentPageResult {
  if (!openedPage?.id) {
    return { page: null };
  }
  return { page: { id: openedPage.id, title: openedPage.title ?? '' } };
}
