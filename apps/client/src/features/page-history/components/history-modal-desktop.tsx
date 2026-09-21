import {
  ActionIcon,
  Box,
  Button,
  Center,
  Divider,
  Group,
  ScrollArea,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import {
  IconChevronDown,
  IconChevronUp,
  IconX,
} from "@tabler/icons-react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  activeHistoryIdAtom,
  activeHistoryPrevIdAtom,
  diffCountsAtom,
  highlightChangesAtom,
} from "@/features/page-history/atoms/history-atoms";
import { usePageHistoryListQuery } from "@/features/page-history/queries/page-history-query";
import { usePageHistoryDayCounts } from "@/features/page-history/queries/day-counts-query";
import HistoryView from "@/features/page-history/components/history-view";
import HistoryNavPanel from "@/features/page-history/components/history-nav-panel";
import {
  useDiffNavigation,
  useHistoryReset,
  useHistoryRestore,
} from "@/features/page-history/hooks";
import { resolvePrevSnapshotId } from "@/features/page-history/utils/resolve-prev-snapshot";
import {
  dayGroupLabel,
  toRevisionRow,
} from "@/features/page-history/utils/revision-row";
import { viewerTimezone } from "@/features/page-history/work-time/work-time-service";
import classes from "./css/history.module.css";

interface Props {
  pageId: string;
  onClose: () => void;
}

/**
 * #568 — redesigned DESKTOP page-history window: a single-row header (title,
 * selected-version label, Highlight-changes toggle + N/M diff navigation, Restore,
 * close) over a two-pane body — LEFT navigation panel (calendar heatmap + dense
 * revision list), RIGHT the rendered version with change highlighting.
 *
 * Mechanics are REUSED verbatim: the same list query + atoms + diff engine +
 * restore hook as the original body. Only the layout and row density change.
 * The mobile branch (history-modal-mobile) is untouched.
 */
export default function HistoryModalDesktop({ pageId, onClose }: Props) {
  const { t } = useTranslation();
  const tz = useMemo(() => viewerTimezone(), []);
  const now = useMemo(() => new Date(), []);
  const scrollViewportRef = useRef<HTMLDivElement>(null);

  const [activeHistoryId, setActiveHistoryId] = useAtom(activeHistoryIdAtom);
  const setActiveHistoryPrevId = useSetAtom(activeHistoryPrevIdAtom);
  const [highlightChanges, setHighlightChanges] = useAtom(highlightChangesAtom);
  const diffCounts = useAtomValue(diffCountsAtom);
  const [onlyVersions, setOnlyVersions] = useState(false);
  // #583 Fix A — EPHEMERAL "picked day" highlight for the calendar, in ADDITION
  // to the existing scroll. Local useState (NOT a jotai atom): the desktop modal
  // unmounts on close, so the highlight resets on next open while the active
  // version persists in activeHistoryIdAtom. When a version/row is selected we
  // clear it (in handleSelect) so the highlight snaps back to the version's day
  // and the two selections never drift apart.
  const [pickedDayISO, setPickedDayISO] = useState<string | null>(null);

  useHistoryReset(pageId);
  const { canRestore, confirmRestore } = useHistoryRestore();
  const { currentChangeIndex, handlePrevChange, handleNextChange } =
    useDiffNavigation(scrollViewportRef);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isError,
    isLoading,
  } = usePageHistoryListQuery(pageId);
  const historyItems = useMemo(
    () => data?.pages.flatMap((page) => page.items) ?? [],
    [data],
  );

  // fail-open: heatmap counts degrade to an empty grid on error; the list and
  // restore keep working.
  const { data: dayCounts } = usePageHistoryDayCounts(pageId);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of dayCounts ?? []) map.set(d.dayISO, d.count);
    return map;
  }, [dayCounts]);

  const handleSelect = useCallback(
    (id: string) => {
      setActiveHistoryId(id);
      // Baseline = true previous snapshot in the FULL flat list (never the
      // filtered/grouped neighbour), so diff/restore stay correct under "Only
      // versions".
      setActiveHistoryPrevId(resolvePrevSnapshotId(historyItems, id));
      // #583 Fix A — clear the ephemeral day pick so the calendar highlight
      // returns to the newly-selected version's day (selectedRow.dayISO).
      setPickedDayISO(null);
    },
    [historyItems, setActiveHistoryId, setActiveHistoryPrevId],
  );

  useEffect(() => {
    if (historyItems.length > 0 && !activeHistoryId) {
      setActiveHistoryId(historyItems[0].id);
      setActiveHistoryPrevId(historyItems[1]?.id ?? "");
    }
  }, [historyItems, activeHistoryId, setActiveHistoryId, setActiveHistoryPrevId]);

  const selectedRow = useMemo(() => {
    const item = historyItems.find((i) => i.id === activeHistoryId);
    return item ? toRevisionRow(item, tz) : null;
  }, [historyItems, activeHistoryId, tz]);

  const selectedLabel = selectedRow
    ? `${dayGroupLabel(selectedRow, tz, now, t)} · ${selectedRow.atLabel}`
    : "—";

  // #568 §C — Restore disabled for the newest snapshot (index 0, globally newest
  // even mid-pagination) and when the viewer lacks Manage-Page.
  const isNewestSelected =
    !!activeHistoryId && historyItems[0]?.id === activeHistoryId;
  const restoreDisabled = !canRestore || isNewestSelected || !selectedRow;

  const showDiffNav =
    highlightChanges && !!diffCounts && diffCounts.total > 0;
  // Diff engine failed for this version: show a muted notice instead of the
  // "N of M" navigation (which would otherwise silently show nothing).
  const showDiffUnavailable =
    highlightChanges && !!diffCounts && diffCounts.failed;

  return (
    <div className={classes.desktopRoot}>
      <Group className={classes.desktopToolbar} gap={14} wrap="nowrap">
        <Text fz={16} fw={600} style={{ flex: "none" }}>
          {t("Page history")}
        </Text>
        <Divider orientation="vertical" my={14} />
        <Stack gap={0} style={{ minWidth: 0 }}>
          <Text fz={12} fw={600} truncate>
            {selectedLabel}
          </Text>
          <Text fz={10.5} c="dimmed">
            {t("Selected version")}
          </Text>
        </Stack>

        <Box style={{ flex: 1 }} />

        <Group gap="xs" wrap="nowrap" style={{ flex: "none" }}>
          <Switch
            size="sm"
            checked={highlightChanges}
            onChange={(e) => setHighlightChanges(e.currentTarget.checked)}
            label={t("Highlight changes")}
            styles={{ label: { userSelect: "none", whiteSpace: "nowrap" } }}
          />
          {showDiffNav && (
            <Group gap={4} wrap="nowrap">
              <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                {currentChangeIndex} {t("of")} {diffCounts.total}
              </Text>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label={t("Previous change")}
                onClick={handlePrevChange}
              >
                <IconChevronUp size={16} />
              </ActionIcon>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label={t("Next change")}
                onClick={handleNextChange}
              >
                <IconChevronDown size={16} />
              </ActionIcon>
            </Group>
          )}
          {showDiffUnavailable && (
            <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
              {t("Change highlighting is unavailable for this version")}
            </Text>
          )}
        </Group>

        <Divider orientation="vertical" my={14} />

        <Button
          size="compact-md"
          onClick={confirmRestore}
          disabled={restoreDisabled}
          style={{ flex: "none" }}
        >
          {t("Restore")}
        </Button>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          aria-label={t("Close")}
          onClick={onClose}
        >
          <IconX size={18} />
        </ActionIcon>
      </Group>

      <div className={classes.desktopBody}>
        <HistoryNavPanel
          fullItems={historyItems}
          activeId={activeHistoryId}
          onSelect={handleSelect}
          fetchNextPage={fetchNextPage}
          hasNextPage={!!hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          isError={isError}
          isLoading={isLoading}
          counts={counts}
          // #583 Fix A — an ephemeral day pick wins over the selected version's
          // day; falls back to the version's day, then null.
          selectedDayISO={pickedDayISO ?? selectedRow?.dayISO ?? null}
          onDayPicked={setPickedDayISO}
          tz={tz}
          onlyVersions={onlyVersions}
          setOnlyVersions={setOnlyVersions}
        />

        <ScrollArea
          className={classes.rightView}
          viewportRef={scrollViewportRef}
          scrollbarSize={5}
        >
          {/* F1 — the right pane mirrors the list state instead of going blank:
              error on a failed history query, an empty state for a page with no
              revisions, otherwise the rendered version. */}
          {isError ? (
            <Center h="100%" p={40}>
              <Text size="sm" c="dimmed" ta="center">
                {t("Error fetching page data.")}
              </Text>
            </Center>
          ) : !isLoading && historyItems.length === 0 ? (
            <Stack align="center" justify="center" h="100%" gap={6} p={40}>
              <Text fw={600} fz="sm">
                {t("No page history saved yet.")}
              </Text>
            </Stack>
          ) : (
            /* #605 Fix C — the article fills the full content-panel width (no
               centered width cap). Keep the 26px 44px side padding
               (.historyEditor .ProseMirror is padding:0 !important, so without it
               the title/text stick to the panel edge). */
            <Box p="26px 44px">
              {activeHistoryId && <HistoryView />}
            </Box>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}
