import { Box, Center, Group, Loader, ScrollArea, Switch, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { IPageHistory } from "@/features/page-history/types/page.types";
import {
  dayGroupLabel,
  groupRevisionsByDay,
  isoDayInTz,
  toRevisionRow,
} from "@/features/page-history/utils/revision-row";
import RevisionRow from "@/features/page-history/components/revision-row";
import MiniCalendar from "@/features/page-history/components/mini-calendar";
import classes from "./css/history.module.css";

// react-query's fetchNextPage returns the accumulated infinite result; typed
// loosely here to avoid re-importing its generics.
type FetchNextPage = () => Promise<{
  data?: { pages: Array<{ items: IPageHistory[] }> };
  hasNextPage?: boolean;
}>;

interface Props {
  fullItems: IPageHistory[];
  activeId: string;
  onSelect: (id: string) => void;
  onHover?: (id: string) => void;
  onHoverEnd?: () => void;
  fetchNextPage: FetchNextPage;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isError: boolean;
  isLoading: boolean;
  counts: Map<string, number>;
  selectedDayISO: string | null;
  // #583 Fix A — notify the parent which day the user picked so it can set the
  // ephemeral calendar highlight. Distinct from MiniCalendar's onPickDay (scroll).
  onDayPicked?: (dayISO: string) => void;
  tz: string;
  onlyVersions: boolean;
  setOnlyVersions: (v: boolean) => void;
}

/**
 * #568 — left navigation panel: "Only versions" filter + mini-calendar heatmap +
 * the DENSE, day-grouped revision list. The grouping is presentational only —
 * selection still resolves the previous snapshot from the FULL flat list (done
 * in the parent), so diff/restore never target a filtered neighbour.
 */
export default function HistoryNavPanel({
  fullItems,
  activeId,
  onSelect,
  onHover,
  onHoverEnd,
  fetchNextPage,
  hasNextPage,
  isFetchingNextPage,
  isError,
  isLoading,
  counts,
  selectedDayISO,
  onDayPicked,
  tz,
  onlyVersions,
  setOnlyVersions,
}: Props) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    const rows = fullItems
      .map((item) => toRevisionRow(item, tz))
      // "Only versions": same predicate as the badge (manual/agent). Note this
      // list filter is version-only, whereas the heatmap counts ALL revisions
      // (#605) — they intentionally describe DIFFERENT sets, so a lit autosave-
      // only day has no row here when the filter is on (handlePickDay toasts).
      .filter((row) => (onlyVersions ? row.version : true));
    return groupRevisionsByDay(rows);
  }, [fullItems, tz, onlyVersions]);

  // Bottom-sentinel auto-load (mirrors history-list.tsx).
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

  const scrollToDay = useCallback((dayISO: string): boolean => {
    const viewport = viewportRef.current;
    if (!viewport) return false;
    // ISO 'YYYY-MM-DD' is attribute-selector safe (digits + hyphens).
    const el = viewport.querySelector(`[data-day="${dayISO}"]`);
    if (el instanceof HTMLElement) {
      viewport.scrollTo({ top: Math.max(el.offsetTop - 8, 0), behavior: "smooth" });
      return true;
    }
    return false;
  }, []);

  const handlePickDay = useCallback(
    async (targetDayISO: string) => {
      if (scrollToDay(targetDayISO)) return;

      // Not in the loaded pages yet — the list is newest-first, so pull pages
      // until the OLDEST loaded day is on/older than the target (a correct
      // dayISO boundary, NOT a fixed page count), or pagination is exhausted.
      let items = fullItems;
      let more = hasNextPage;
      let guard = 0;
      while (more && guard < 200) {
        const last = items[items.length - 1];
        const oldestDay = last
          ? isoDayInTz(new Date(last.createdAt), tz)
          : null;
        if (oldestDay && oldestDay <= targetDayISO) break;
        const res = await fetchNextPage();
        items = res.data?.pages.flatMap((p) => p.items) ?? items;
        more = res.hasNextPage ?? false;
        guard++;
      }

      // Let React paint the newly-loaded rows before scrolling to the anchor.
      requestAnimationFrame(() => {
        if (!scrollToDay(targetDayISO)) {
          // Unreachable day (exhausted pagination): explicit no-op + toast, never
          // a silent hang.
          notifications.show({
            message: t("No revisions found for that day"),
            color: "gray",
          });
        }
      });
    },
    [scrollToDay, fullItems, hasNextPage, fetchNextPage, tz, t],
  );

  const now = useMemo(() => new Date(), []);

  return (
    <Box className={classes.navPanel}>
      <Group className={classes.navFilterRow} justify="space-between" wrap="nowrap">
        <Switch
          size="xs"
          checked={onlyVersions}
          onChange={(e) => setOnlyVersions(e.currentTarget.checked)}
          label={t("Only versions")}
        />
      </Group>

      <MiniCalendar
        counts={counts}
        selectedDayISO={selectedDayISO}
        // #583 Fix A — COMPOSE both handlers: set the ephemeral highlight first,
        // then run the existing scroll/load. Setting the highlight up front means
        // it lands even when handlePickDay early-returns (day already visible).
        // handlePickDay's scroll/load logic is unchanged.
        onPickDay={(d) => {
          onDayPicked?.(d);
          handlePickDay(d);
        }}
        tz={tz}
      />

      <ScrollArea style={{ flex: 1 }} viewportRef={viewportRef} scrollbarSize={5}>
        {/* F1 — explicit error/empty states instead of a blank panel. The
            heatmap fails open independently; the list keeps its own states.
            The empty state is gated on !isLoading so it doesn't flash the
            "no history" text during the initial query, mirroring the right pane. */}
        {isError ? (
          <Center py="md" px="sm">
            <Text size="sm" c="dimmed" ta="center">
              {t("Error loading page history.")}
            </Text>
          </Center>
        ) : !isLoading && groups.length === 0 ? (
          <Center py="md" px="sm">
            <Text size="sm" c="dimmed" ta="center">
              {onlyVersions
                ? t("No saved versions yet.")
                : t("No page history saved yet.")}
            </Text>
          </Center>
        ) : null}
        {!isError &&
          groups.map((group) => (
          <Box key={group.dayISO}>
            <Text
              className={classes.dayHeading}
              data-day={group.dayISO}
              data-testid="day-heading"
            >
              {dayGroupLabel(group, tz, now, t)}
            </Text>
            {group.rows.map((row) => (
              <RevisionRow
                key={row.id}
                row={row}
                selected={row.id === activeId}
                onSelect={onSelect}
                onHover={onHover}
                onHoverEnd={onHoverEnd}
              />
            ))}
          </Box>
        ))}
        {hasNextPage && <div ref={loadMoreRef} style={{ height: 1 }} />}
        {isFetchingNextPage && (
          <Center py="sm">
            <Loader size="sm" />
          </Center>
        )}
      </ScrollArea>
    </Box>
  );
}
