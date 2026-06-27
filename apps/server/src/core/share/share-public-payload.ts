import { Page } from '@docmost/db/types/entity.types';

/**
 * The EXACT shape returned to anonymous public-share viewers by the
 * `/shares/page-info` route — the only unauthenticated path that serializes the
 * full {page, share} records. This is a security boundary (#218): the raw rows
 * carry internal metadata — creatorId/lastUpdatedById/contributorIds,
 * spaceId/workspaceId, AI/source bookkeeping, lock/template flags,
 * parent/position and raw timestamps — none of which may leak to an
 * unauthenticated viewer. Keeping the allowlist as an explicit TYPE plus a
 * single mapper means a new leaking field cannot be returned without also
 * widening this contract (and tripping its key-test in share.controller.spec.ts).
 */
export interface PublicSharePayload {
  page: {
    id: string;
    slugId: string;
    title: string | null;
    icon: string | null;
    content: unknown;
  };
  share: {
    id: string;
    key: string;
    includeSubPages: boolean | null;
    searchIndexing: boolean | null;
    level: number;
    sharedPage: unknown;
  };
}

/**
 * The subset of the resolved share read by the public payload. Declared
 * structurally so the richer getShareForPage result (which adds `level` and
 * `sharedPage` on top of the base Shares row) passes without a cast.
 */
interface PublicShareSource {
  id: string;
  key: string;
  includeSubPages: boolean | null;
  searchIndexing: boolean | null;
  // `level` is derived via a SQL literal in getShareForPage, so it surfaces as
  // `unknown` in the resolved share; it is a number at runtime.
  level: unknown;
  sharedPage: unknown;
}

export function toPublicSharePayload(
  page: Page,
  share: PublicShareSource,
): PublicSharePayload {
  return {
    page: {
      id: page.id,
      slugId: page.slugId,
      title: page.title,
      icon: page.icon,
      content: page.content,
    },
    share: {
      id: share.id,
      key: share.key,
      includeSubPages: share.includeSubPages,
      searchIndexing: share.searchIndexing,
      level: share.level as number,
      sharedPage: share.sharedPage,
    },
  };
}
