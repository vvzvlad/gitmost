import { useParams } from "react-router-dom";
import { usePageQuery } from "@/features/page/queries/page-query";
import { FullEditor } from "@/features/editor/full-editor";
import HistoryModal from "@/features/page-history/components/history-modal";
import { Helmet } from "react-helmet-async";
import PageHeader from "@/features/page/components/header/page-header.tsx";
import { extractPageSlugId } from "@/lib";
import { useGetSpaceBySlugQuery } from "@/features/space/queries/space-query.ts";
import { useTranslation } from "react-i18next";
import React, { useEffect, useRef } from "react";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { IconAlertTriangle, IconFileOff } from "@tabler/icons-react";
import { Button, Skeleton } from "@mantine/core";
import { Link } from "react-router-dom";
import { ErrorBoundary } from "react-error-boundary";
import {
  derivePageChromeCanEdit,
  useCachedPageMeta,
} from "@/features/page/atoms/page-meta-cache-atom";
import { reportClientMetric } from "@/lib/telemetry/vitals";
import { isLocalFirstEnabled } from "@/lib/config";
import { useAtomValue } from "jotai";
import { scopeKeyAtom } from "@/features/page/tree/atoms/open-tree-nodes-atom";
import { hasLocalPageBody } from "@/features/editor/page-ydoc-eviction";
import { reportOfflineCriticalServerError } from "@/lib/http-error";
import { classifyPageError } from "./page-render-decision";
import { IconCloudOff } from "@tabler/icons-react";
const MemoizedFullEditor = React.memo(FullEditor);
const MemoizedPageHeader = React.memo(PageHeader);
const MemoizedHistoryModal = React.memo(HistoryModal);

export default function Page() {
  const { t } = useTranslation();
  const { pageSlug } = useParams();

  return (
    <ErrorBoundary
      resetKeys={[pageSlug]}
      fallbackRender={({ resetErrorBoundary }) => (
        <EmptyState
          icon={IconAlertTriangle}
          title={t("Failed to load page. An error occurred.")}
          action={
            <Button variant="default" size="sm" mt="xs" onClick={resetErrorBoundary}>
              {t("Try again")}
            </Button>
          }
        />
      )}
    >
      <PageContent pageSlug={pageSlug} />
    </ErrorBoundary>
  );
}

function PageContent({ pageSlug }: { pageSlug: string | undefined }) {
  const { t } = useTranslation();
  // The URL space slug is the only space identifier available when offline (the
  // #563 meta cache deliberately stores none): used to source the read-only
  // offline body's chrome links when the live `page` is absent.
  const { spaceSlug: urlSpaceSlug } = useParams();
  const pageSlugId = extractPageSlugId(pageSlug);

  const {
    data: page,
    isLoading,
    isError,
    error,
  } = usePageQuery({ pageId: pageSlugId });
  const { data: space } = useGetSpaceBySlugQuery(page?.space?.slug);

  // #563 — local-first phase 1. The boot cache is read SYNCHRONOUSLY (jotai
  // atomWithStorage + getOnInit), so the chrome below no longer waits for THIS
  // page's `/pages/info` round-trip: it renders from the cached metadata the
  // moment this component mounts.
  //
  // What that does NOT (yet) mean: a paint on the very first frame of a reload.
  // UserProvider still returns nothing until `/me` resolves (user-provider.tsx —
  // `if (isLoading) return <></>`) and it wraps ALL authenticated routing, so the
  // app shell — this page included — is still gated on that ONE request. Phase 1
  // removes the SECOND, sequential round-trip (`/pages/info`, which today only
  // starts after `/me`), not the first. A true first-frame paint additionally
  // needs the `/me` gate lifted (a persisted current-user), which is out of
  // scope here.
  //
  // Precedence: the LIVE query always wins — the cached entry only fills the gap
  // until it resolves. Reconciliation is automatic: usePageQuery force-refetches
  // on every mount and writes the fresh page back through to the cache, so a
  // rename/icon/permission change lands as soon as the response arrives (and
  // re-renders the chrome).
  const cachedMeta = useCachedPageMeta(pageSlugId);
  // `placeholderData: keepPreviousData` means `page` can still hold the PREVIOUS
  // page while we navigate into this one, so it only counts as live data for THIS
  // page when its identifiers match the URL. Otherwise the cached entry (which is
  // this page's) drives the chrome.
  const livePage =
    page && (page.slugId === pageSlugId || page.id === pageSlugId)
      ? page
      : undefined;
  const chromeMeta = livePage ?? cachedMeta;

  // FAIL-CLOSED edit rights. `canEdit` is derived from the LIVE page only —
  // never from the cache. A permission DOWNGRADE (editor -> viewer) keeps the
  // page readable, so it produces no 403/404 and nothing evicts the cached entry;
  // trusting a cached `canEdit:true` would therefore offer Share / Save version /
  // Move / Delete / the edit toggle to a user the server has already demoted,
  // until `/pages/info` lands. The chrome (title, icon, breadcrumbs) still paints
  // instantly from the cache; only the edit affordances wait for the network.
  const canEdit = derivePageChromeCanEdit(livePage);
  // The BODY still renders whatever the query holds (previous page included, as
  // today), so its edit rights must come from THAT page — never from the chrome's
  // possibly-different metadata.
  const canEditBody = derivePageChromeCanEdit(page);
  const canComment =
    canEditBody ||
    (space?.settings?.comments?.allowViewerComments === true);

  // Boot-cache hit/miss counter — once per visited page. Telemetry is a no-op
  // unless the operator enabled it AND the session is sampled. Reported ONLY
  // when the local-first flag is on: with the flag off the cache is never read,
  // so every visit would trivially count as a miss and drown the flag-ON hit
  // rate — and the flag-OFF `page_open_ms` baseline this feature is measured
  // against would be polluted by counters that describe nothing.
  const countedSlugId = useRef<string | null>(null);
  useEffect(() => {
    if (!isLocalFirstEnabled()) return;
    if (!pageSlugId || countedSlugId.current === pageSlugId) return;
    countedSlugId.current = pageSlugId;
    // Deliberately NOT keyed on `cachedMeta`: the counter records what the cache
    // held when this page was opened, not what the network later wrote back.
    reportClientMetric(cachedMeta ? "page_meta_hit" : "page_meta_miss", 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSlugId]);

  // #641 — offline-first error taxonomy. A 5xx on this OFFLINE-CRITICAL request
  // must NEVER be shown as "offline, cached copy" (part 4): it is surfaced as an
  // error AND reported to the always-on safety channel, distinct from an
  // unreachable network. Reported once per distinct error object so a re-render
  // does not double-count. No-op with the flag off or for a transport/auth error.
  const reportedErrorRef = useRef<unknown>(null);
  useEffect(() => {
    if (!isLocalFirstEnabled() || !isError) return;
    if (reportedErrorRef.current === error) return;
    reportedErrorRef.current = error;
    reportOfflineCriticalServerError(error, "/pages/info");
  }, [isError, error]);

  // Synchronous, best-effort "is there a local body to fall back on?" — drives
  // the offline-local vs offline-empty split without an async IndexedDB open.
  const scopeKey = useAtomValue(scopeKeyAtom);
  const hasLocalBody =
    isLocalFirstEnabled() && chromeMeta
      ? hasLocalPageBody(scopeKey, chromeMeta.id, chromeMeta.slugId)
      : false;

  // The network ALWAYS wins over the cache: a deleted page / revoked access
  // (401/403/404) renders not-found, never the stale cached chrome. The cached
  // entry itself is dropped by the global query-cache subscriber
  // (installPageMetaEviction), so the next visit is a clean miss — no flash of
  // stale chrome. Same second condition as before: a settled query with no data
  // and no error (e.g. a missing slug) still shows the error state.
  //
  // With local-first ON, a TRANSPORT (unreachable) error no longer collapses to
  // the error screen: if we have the cached chrome it renders chrome + the local
  // body (offline-local) or, when no local body exists, an explicit
  // "not available offline" empty-state (offline-empty). See classifyPageError.
  if (isError || (!isLoading && !page)) {
    const decision = classifyPageError({
      localFirst: isLocalFirstEnabled(),
      error,
      hasChromeMeta: !!chromeMeta,
      hasLocalBody,
    });

    if (decision === "not-found") {
      return (
        <EmptyState
          icon={IconFileOff}
          title={t("Page not found")}
          description={t(
            "This page may have been deleted, moved, or you may not have access.",
          )}
          action={
            <Button component={Link} to="/home" variant="default" size="sm" mt="xs">
              {t("Go to homepage")}
            </Button>
          }
        />
      );
    }

    if (decision === "offline-empty") {
      return (
        <EmptyState
          icon={IconCloudOff}
          title={t("This page isn't available offline")}
          description={t(
            "Connect to the internet to load this page for the first time on this device.",
          )}
        />
      );
    }

    if (decision === "error-screen") {
      return (
        <EmptyState
          icon={IconFileOff}
          title={t("Error fetching page data.")}
        />
      );
    }

    // decision === "offline-local": fall through to render the cached chrome and
    // the read-only local body below. Ф7 (#643) — the body now mounts from
    // `chromeMeta` with `content={livePage?.content}` (absent here), so the local
    // ydoc drives it directly; no separate offline-local body branch is needed.
  }

  // Cache MISS (first visit to this page in this browser, flag off, corrupt
  // cache, or an unresolved user) → today's behavior, unchanged.
  if (!chromeMeta) {
    return <PageSkeleton />;
  }

  return (
    <div>
      <Helmet>
        {/* The page icon is now a Lucide IconRef (JSON), not a renderable glyph
            in a text-only <title>; show just the title so no raw value leaks. */}
        <title>{chromeMeta.title || t("Untitled")}</title>
      </Helmet>

      <MemoizedPageHeader readOnly={!canEdit} />

      {/* BODY. Ф7 (#643) — with local-first ON the body no longer waits for BOTH
          `/pages/info` AND `/spaces/info`: the editor mounts on `chromeMeta`
          (cache or live), keyed by `chromeMeta.id`, and renders from the local
          ydoc, with its SKELETON / static / live states owned inside PageEditor
          via `bodyContentPending`. The props contract closes the data-loss traps:
          `content` comes ONLY from `livePage` (never the possibly-PREVIOUS `page`
          under keepPreviousData, or B would show A's body); `editable` from
          `livePage` (fail-closed until the live page confirms); `spaceSlug` from
          the ROUTE (`useParams`), never the cache (which stores none); `title`/
          `slugId` from `chromeMeta` for an instant title. Flag OFF → today's
          `page && space` gate, byte-for-behavior unchanged. */}
      {isLocalFirstEnabled() ? (
        <>
          <MemoizedFullEditor
            key={chromeMeta.id}
            pageId={chromeMeta.id}
            title={chromeMeta.title}
            content={livePage?.content}
            slugId={chromeMeta.slugId}
            spaceSlug={urlSpaceSlug ?? ""}
            editable={canEdit}
            creator={livePage?.creator}
            contributors={livePage?.contributors}
            canComment={canComment}
            bodyContentPending={isLoading || !livePage}
          />
          <MemoizedHistoryModal pageId={chromeMeta.id} />
        </>
      ) : page && space ? (
        <>
          <MemoizedFullEditor
            key={page.id}
            pageId={page.id}
            title={page.title}
            content={page.content}
            slugId={page.slugId}
            spaceSlug={page?.space?.slug}
            editable={canEditBody}
            creator={page.creator}
            contributors={page.contributors}
            canComment={canComment}
          />
          <MemoizedHistoryModal pageId={page.id} />
        </>
      ) : (
        <PageSkeleton />
      )}
    </div>
  );
}

// Lightweight loading placeholder shown instead of a blank fragment while the
// page (or its space) is loading, so navigation into a not-yet-cached page no
// longer flashes empty. Approximates the title + first content lines.
function PageSkeleton() {
  return (
    <div>
      <Skeleton height={34} width="45%" mt="xl" radius="sm" />
      <Skeleton height={16} mt="xl" radius="sm" />
      <Skeleton height={16} mt="sm" radius="sm" />
      <Skeleton height={16} mt="sm" width="85%" radius="sm" />
      <Skeleton height={16} mt="sm" width="70%" radius="sm" />
    </div>
  );
}
