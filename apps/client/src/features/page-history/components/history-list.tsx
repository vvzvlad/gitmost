import {
  usePageHistoryListQuery,
  prefetchPageHistory,
} from "@/features/page-history/queries/page-history-query";
import HistoryItem, {
  historyKindMeta,
} from "@/features/page-history/components/history-item";
import {
  activeHistoryIdAtom,
  activeHistoryPrevIdAtom,
  historyAtoms,
} from "@/features/page-history/atoms/history-atoms";
import { useAtom, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  ScrollArea,
  Group,
  Divider,
  Loader,
  Center,
  Switch,
  Text,
} from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useHistoryRestore } from "@/features/page-history/hooks";
import { resolvePrevSnapshotId } from "@/features/page-history/utils/resolve-prev-snapshot";

const PREFETCH_DELAY_MS = 150;

interface Props {
  pageId: string;
}

function HistoryList({ pageId }: Props) {
  const { t } = useTranslation();
  const [activeHistoryId, setActiveHistoryId] = useAtom(activeHistoryIdAtom);
  const setActiveHistoryPrevId = useSetAtom(activeHistoryPrevIdAtom);
  const setHistoryModalOpen = useSetAtom(historyAtoms);

  const {
    data: pageHistoryData,
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = usePageHistoryListQuery(pageId);

  const historyItems = useMemo(
    () => pageHistoryData?.pages.flatMap((page) => page.items) ?? [],
    [pageHistoryData],
  );

  // #370 — "only versions" filter: hide autosnapshots (idle/boundary/legacy
  // null), keep only intentional points (manual/agent). Filtering is over the
  // already-loaded pages; the diff/restore still targets the true previous
  // snapshot, so items carry their index within the FULL list.
  const [onlyVersions, setOnlyVersions] = useState(false);
  // Reuse historyKindMeta().version — the SAME predicate the badge (HistoryItem)
  // uses to mark intentional points — so the "Only versions" filter and the badge
  // can never drift apart when a future intentional kind is added.
  const visibleItems = useMemo(
    () =>
      onlyVersions
        ? historyItems.filter((item) => historyKindMeta(item.kind).version)
        : historyItems,
    [historyItems, onlyVersions],
  );

  const loadMoreRef = useRef<HTMLDivElement>(null);
  const prefetchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { canRestore, confirmRestore } = useHistoryRestore();

  const clearPrefetchTimeout = useCallback(() => {
    if (prefetchTimeoutRef.current) {
      clearTimeout(prefetchTimeoutRef.current);
      prefetchTimeoutRef.current = null;
    }
  }, []);

  const handleHover = useCallback(
    (historyId: string) => {
      clearPrefetchTimeout();
      prefetchTimeoutRef.current = setTimeout(() => {
        prefetchPageHistory(historyId);
        // The true previous snapshot in the FULL list (not the previous visible
        // one under the "only versions" filter).
        const prevId = resolvePrevSnapshotId(historyItems, historyId);
        if (prevId) {
          prefetchPageHistory(prevId);
        }
      }, PREFETCH_DELAY_MS);
    },
    [clearPrefetchTimeout, historyItems],
  );

  useEffect(() => {
    return clearPrefetchTimeout;
  }, [clearPrefetchTimeout]);

  const handleSelect = useCallback(
    (id: string) => {
      setActiveHistoryId(id);
      // Baseline = true previous snapshot in the FULL list, so the "only
      // versions" filter never diffs/restores against the wrong item.
      setActiveHistoryPrevId(resolvePrevSnapshotId(historyItems, id));
    },
    [historyItems, setActiveHistoryId, setActiveHistoryPrevId],
  );

  useEffect(() => {
    if (historyItems.length > 0 && !activeHistoryId) {
      setActiveHistoryId(historyItems[0].id);
      setActiveHistoryPrevId(historyItems[1]?.id ?? "");
    }
  }, [
    historyItems,
    activeHistoryId,
    setActiveHistoryId,
    setActiveHistoryPrevId,
  ]);

  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!sentinel || !hasNextPage) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { threshold: 0.1 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  if (isLoading) {
    return <></>;
  }

  if (isError) {
    return <div>{t("Error loading page history.")}</div>;
  }

  if (historyItems.length === 0) {
    return <>{t("No page history saved yet.")}</>;
  }

  return (
    <div>
      <Group px="xs" py={6} justify="flex-end">
        <Switch
          size="xs"
          checked={onlyVersions}
          onChange={(e) => setOnlyVersions(e.currentTarget.checked)}
          label={t("Only versions")}
        />
      </Group>

      <ScrollArea h={620} w="100%" type="scroll" scrollbarSize={5}>
        {onlyVersions && visibleItems.length === 0 && (
          <Center py="md">
            <Text size="sm" c="dimmed">
              {t("No saved versions yet.")}
            </Text>
          </Center>
        )}
        {visibleItems.map((historyItem) => (
          <HistoryItem
            key={historyItem.id}
            historyItem={historyItem}
            onSelect={handleSelect}
            onHover={handleHover}
            onHoverEnd={clearPrefetchTimeout}
            isActive={historyItem.id === activeHistoryId}
          />
        ))}
        {hasNextPage && <div ref={loadMoreRef} style={{ height: 1 }} />}
        {isFetchingNextPage && (
          <Center py="sm">
            <Loader size="sm" />
          </Center>
        )}
      </ScrollArea>

      {canRestore && (
        <>
          <Divider />
          <Group p="xs" wrap="nowrap">
            <Button
              variant="default"
              size="compact-md"
              onClick={() => setHistoryModalOpen(false)}
            >
              {t("Cancel")}
            </Button>
            <Button size="compact-md" onClick={confirmRestore}>
              {t("Restore")}
            </Button>
          </Group>
        </>
      )}
    </div>
  );
}

export default HistoryList;
